# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

libclaude wraps the local `claude` CLI in a TypeScript Node API (the same
persistent stream-json approach as the `claude-line` skill), then layers a
transport-pluggable typed RPC contract and a React web UI on top. The point is
to drive the real `claude` executable (with all its capabilities) the way you'd
drive the Claude Agent SDK, plus an interactive browser session.

## Commands

- `npm install` - install all workspaces (npm workspaces; deps hoist to root).
- `npm run dev` - run backend (`tsx watch`, port 4000, **auth disabled**) and the
  Vite dev server (port 5173) together. Open http://localhost:5173. Vite proxies
  `/ws` and `/health` to the backend.
- `npm run dev:server` / `npm run dev:web` - run one side only.
- `npm run check` - typecheck every workspace (`tsc --noEmit` per project, in
  dependency order). This is the canonical "did I break types" gate.
- `npm run build` - production build of the web app (`apps/web/dist`).
- `npm start` - run the backend in production; it serves `apps/web/dist` and
  `/ws` on one port. Requires `npm run build` first.

There is no test runner wired up yet. To smoke-test the full path without
spending tokens on real `claude`, point `LIBCLAUDE_CLAUDE_BIN` at a stub script
that reads stream-json `user` messages on stdin and writes `system/init`,
`assistant`, and `result` events on stdout.

## Architecture

Five workspaces, two layers. Data flows: browser `RpcClient` → WebSocket →
`RpcServer` → `ClaudeSession` → `claude` child process, and events stream back
the same path.

- `packages/core` (`@libclaude/core`) - the CLI wrapper. `ClaudeSession` spawns
  one long-lived `claude -p --input-format stream-json --output-format
  stream-json` process and treats each prompt as one turn in the **same**
  conversation. Turns are **serialized**: one runs at a time, extras queue.
  `query()` is an async generator streaming events (returns the buffered
  `TurnResult`); `prompt()` is the buffered form. Emits `event`/`status`/`error`.
  This package is the only one that touches Node child-process APIs.
- `packages/rpc` (`@libclaude/rpc`) - transport-agnostic typed RPC. The wire
  format and procedure typing live in `wire.ts`; `RpcClient`/`RpcServer` are
  generic over a procedure map and talk only through the `ClientTransport` /
  `ServerTransport` interfaces in `transport.ts`. `protocol.ts` is the **one
  concrete contract** (`Procedures`) shared by both sides. WebSocket transports
  are subpath exports (`@libclaude/rpc/ws-client`, `.../ws-server`), modelled on
  the mux RPC layer (reconnect + re-subscribe on the client, `noServer` upgrade
  with token auth on the server).
- `packages/react` (`@libclaude/react`) - `useClaudeSession(rpc)` hook +
  `ClaudeView` component. Pure browser code; consumes an `RpcClient<Procedures>`.
- `apps/server` (`@libclaude/server`) - wires a `ClaudeSession` to the RPC
  contract (`handlers.ts`) and hosts it over the WebSocket transport with token
  auth + static serving (`main.ts`).
- `apps/web` (`@libclaude/web`) - Vite React app; one `RpcClient` over the
  WebSocket client transport, rendering `ClaudeView`.

### Things that will bite you

- **No library build step.** Workspaces resolve to each other's TS *source* via
  tsconfig `paths` (for `tsc`) and Vite `resolve.alias` (for the bundle). When
  you add a new package or subpath export, update **both** `tsconfig.base.json`
  paths and `apps/web/vite.config.ts` aliases.
- **Keep Node code out of the browser's type/bundle graph.** The web/react
  programs typecheck any source they transitively import. Core's runtime
  (`session.ts`) pulls in `node:*`, which would fail under the DOM-only config -
  so RPC imports Claude types from the node-free `@libclaude/core/types`
  subpath, never from the package root. Don't make `protocol.ts` (or anything
  reachable from the web) import the core package root.
- **`Procedures` must stay a `type` alias, not an `interface`** - it has to
  satisfy the `Record<string, ProcedureDef>` constraint (`AnyProcedures`).
  Each entry's `type` field carries a literal kind (`ProcedureDef<"query", ...>`)
  so the client's query/subscription discrimination works; don't widen it.
- **Auth.** `npm run dev` sets `LIBCLAUDE_NO_AUTH=true`. In production the token
  is validated on the WebSocket upgrade and the web client reads it from the
  `?token=` query param. `LIBCLAUDE_NO_AUTH` is only safe bound to loopback.

### Backend env vars (apps/server)

`PORT`/`LIBCLAUDE_PORT`, `LIBCLAUDE_HOST`, `LIBCLAUDE_TOKEN`,
`LIBCLAUDE_NO_AUTH`, `LIBCLAUDE_CWD`, `LIBCLAUDE_MODEL`,
`LIBCLAUDE_PERMISSION_MODE`, `LIBCLAUDE_CLAUDE_BIN`, `LIBCLAUDE_ARGS`.

## Adding an RPC procedure (the common change)

1. Add the entry to `Procedures` in `packages/rpc/src/protocol.ts` with a literal
   kind, input, and output.
2. Implement it in `apps/server/src/handlers.ts` (`.query(...)` or
   `.subscription(...)`). Subscriptions return a cleanup function.
3. Call it from the client / `useClaudeSession`. Types flow automatically; a
   mismatch is a compile error on both sides. Run `npm run check`.
