# Claude UI (CLI-backed sessions)

Live Claude sessions backed by `@libclaude/core`'s `ClaudeSession` are hosted
in the terminal daemon (`src/daemon/claude-ui-manager.ts`'s `ClaudeUiManager`),
the same detached process that already owns terminal PTYs and headless
`many agent` sessions — so a Claude UI session survives the web server /
Electron app closing and is still there when it reconnects. `ClaudeUiService`
(service.ts) is now a thin async RPC client over the daemon
(`TerminalManagerClient`); it no longer owns any `ClaudeSession` itself.

`ClaudeUiManager` spawns one long-lived
`claude -p --input-format stream-json --output-format stream-json --verbose`
process per session and treats each prompt as a turn in the same conversation.
It maps raw CLI events to `ClaudeUiEvent`s (protocol.ts) and broadcasts them to
subscribers (over the daemon socket) with a replay buffer for reconnects.

## stream-json control protocol

Everything is newline-delimited JSON over the child process's stdin/stdout.
Two message families flow over the same pipes:

- **Transcript events** (CLI -> us): `system`/init, `assistant`, `user`,
  `result`. Mapped in `mapClaudeEvent`.
- **Control messages** (bidirectional): `control_request` / `control_response`.

Verified against the Agent SDK source
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`). The SDK is just a
wrapper over the same CLI invocation, so anything it does is reproducible by
reading/writing JSON lines ourselves.

### Direction matters

- **We -> CLI** `control_request`s (already implemented in
  `libclaude/packages/core/src/session.ts`): `interrupt`,
  `set_permission_mode`, `generate_session_title`. We send these and match the
  CLI's `control_response` by `request_id` (`handleControlResponse`).
- **CLI -> us** `control_request`s (NOT yet handled): the CLI asks *us*
  something and waits for our `control_response`. The readline loop currently
  drops these. `can_use_tool` (permission prompts) is the important one.

## Permission modes: DONE

`setPermissionMode` sends `control_request` / `set_permission_mode`. Covers the
full settable set: `default`, `acceptEdits`, `plan`, `bypassPermissions`
(plus our `auto` default). Mode also re-applies on respawn after a crash.

## Accept / reject individual changes (`can_use_tool`): NOT WIRED

This is the per-tool approval prompt. It is fully supportable over JSON lines;
it just needs the reverse-direction control request handled. Three changes, all
in `libclaude/packages/core/src/session.ts`:

1. **Enable routing.** Add `--permission-prompt-tool stdio` in `buildArgs()`.
   Without it the CLI decides from mode/settings and never asks. (The SDK pushes
   exactly `--permission-prompt-tool stdio` when a `canUseTool` callback is set.)
   Note: `bypassPermissions` mode suppresses prompts entirely.

2. **Handle the inbound `control_request`** in the `rl.on("line")` branch
   (alongside the existing `control_response` case). Shape from the CLI:
   ```json
   {"type":"control_request","request_id":"...",
    "request":{"subtype":"can_use_tool","tool_name":"Edit","input":{...},
               "tool_use_id":"...","permission_suggestions":...,
               "title":...,"description":...,"display_name":...,
               "blocked_path":...,"decision_reason":...}}
   ```
   Also handle `control_cancel_request` (CLI cancels a pending prompt, e.g. on
   interrupt) so stale UI prompts get cleared.

3. **Write back the decision** as a `control_response` reusing the same
   `request_id`:
   ```json
   // allow (echo input back, optionally modified):
   {"type":"control_response","response":{"subtype":"success","request_id":"...",
     "response":{"behavior":"allow","updatedInput":{...},"toolUseID":"..."}}}
   // reject:
   {"type":"control_response","response":{"subtype":"success","request_id":"...",
     "response":{"behavior":"deny","message":"User denied"}}}
   ```
   The SDK's `canUseTool` result is `{behavior:"allow", updatedInput} |
   {behavior:"deny", message}`, and the SDK adds `toolUseID` to the response.

Then surface it: track the pending `request_id` in `ManagedSession`, emit a new
`ClaudeUiEvent` (e.g. `permission_request`) up to the renderer, and resolve it
when the user clicks allow/deny (write the `control_response`).

## Permission UI contract

The permission flow surfaces a `PermissionRequest` and resolves it allow/deny.
The UI contract lives in protocol.ts:

- `PermissionRequest` (requestId, toolName, toolInput, description, displayName)
- `permission_request` / `permission_resolved` events
- result `{behavior:"allow"} | {behavior:"deny", message}`

History note: an earlier SDK-based session wrapper
(`src/claude-session/server/claude-service.ts`, on `@anthropic-ai/claude-agent-sdk`)
implemented this via the SDK's `canUseTool` callback. It has been removed; the
CLI-backed `ClaudeUiManager` is now the only implementation.

## Learning the protocol from the Agent SDK source

The docs do not spell out the wire-level control protocol, but the SDK bundle
does. It is the authoritative reference because the SDK literally spawns the
same `claude -p --input-format stream-json --output-format stream-json` process
and exchanges these JSON lines. To re-derive or extend our handling, read it.

- **File:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`. It is
  minified (single-letter identifiers, no newlines), so don't try to read it
  top-to-bottom. Grep for protocol string literals with surrounding bytes:
  ```sh
  # survey which control subtypes exist
  grep -oE '"subtype":"[a-z_]*"|subtype:"[a-z_]*"' sdk.mjs | sort -u

  # pull a method/handler with N bytes of trailing context
  grep -oE 'subtype==="can_use_tool"\)\{.{700}' sdk.mjs
  grep -oE 'handleControlRequest\([A-Za-z]\)\{.{400}' sdk.mjs
  grep -oE '.{40}control_response.{300}' sdk.mjs
  grep -oE 'permission-prompt-tool.{120}' sdk.mjs
  ```
  Vary the `.{N}` byte window to widen/narrow the slice. Match on the stable
  string literals (`control_request`, `can_use_tool`, `set_permission_mode`,
  `--permission-prompt-tool`, `behavior`, `updatedInput`), not on the mangled
  identifiers, which change between SDK versions.

- **Code landmarks** (names are version-specific; find them by the literals):
  - The transport/query driver class holds `canUseTool`, `hooks`,
    `pendingControlResponses`, and `hasBidirectionalNeeds()`. That last method
    returns true when any of `canUseTool` / `hooks` / SDK MCP servers /
    `onElicitation` is set, which is what flips the CLI into bidirectional mode.
  - `request(Q)` builds `{request_id, type:"control_request", request:Q}`,
    stores a resolver in `pendingControlResponses` keyed by `request_id`. This
    is the **we -> CLI** path (interrupt, set_permission_mode, etc.).
  - The read loop dispatches inbound messages by `type`: `control_response`
    (resolve a pending request by `response.request_id`), `control_request`
    (`handleControlRequest`), `control_cancel_request`, and ignores
    `keep_alive` / `streamlined_text` / `streamlined_tool_use_summary`.
  - `handleControlRequest` wraps the result as
    `{type:"control_response", response:{subtype:"success", request_id, response:X}}`,
    and routes by `request.subtype`: `can_use_tool` -> the `canUseTool`
    callback, `hook_callback` -> hooks, `mcp_message` -> SDK MCP transports.
    This is the **CLI -> us** path we still need to implement.
  - The CLI arg builder pushes the base
    `--output-format stream-json --verbose --input-format stream-json` and adds
    `--permission-prompt-tool stdio` only when a `canUseTool` callback exists.

- **Gotcha:** an error `control_response` can carry
  `pending_permission_requests`; the SDK drains them through the same
  `can_use_tool` handler. Permission prompts are not always a standalone inbound
  `control_request`, so route by subtype, not by message position.

- **Cross-check before trusting a slice:** the same literals appear twice in the
  bundle (the `query()` path and the `unstable_v2_*` session path). Confirm a
  shape against both occurrences, and prefer it over guessing from field names.
