# libclaude

Drive the local `claude` CLI through a TypeScript Node API, a transport-pluggable
typed RPC layer, and a React web UI.

Unlike the Claude Agent SDK, this runs the actual `claude` executable (persistent
`claude -p` in stream-json mode, one process = one multi-turn conversation), so
you get the full capabilities of the CLI behind an SDK-shaped interface.

## Layout

| Workspace | What it is |
|-----------|------------|
| `packages/core` | `ClaudeSession` - wraps the `claude` CLI. `query()` (streaming) / `prompt()` (buffered). |
| `packages/rpc` | Transport-agnostic typed RPC: `Procedures` contract, `RpcClient`/`RpcServer`, WebSocket transports. |
| `packages/react` | `useClaudeSession` hook + `ClaudeView` component. |
| `apps/server` | Node backend: `ClaudeSession` over the WebSocket RPC transport. |
| `apps/web` | Vite React frontend. |

## Quick start

```bash
npm install
npm run dev      # backend :4000 (auth off) + Vite :5173
open http://localhost:5173
```

Production:

```bash
npm run build
LIBCLAUDE_TOKEN=$(openssl rand -hex 24) npm start
# open http://127.0.0.1:4000/?token=<token>
```

## Using the core API directly

```ts
import { createSession } from "@libclaude/core";

const session = createSession({ cwd: process.cwd(), permissionMode: "auto" });
for await (const event of session.query("summarise this repo in 3 bullets")) {
  console.log(event.type);
}
const turn = await session.prompt("now do it as a haiku");
console.log(turn.result);
session.dispose();
```

The RPC layer is generic; the WebSocket transport is one implementation. Swap in
any duplex channel by implementing `ClientTransport` / `ServerTransport`.
