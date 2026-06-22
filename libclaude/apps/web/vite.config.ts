import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (rel: string) => new URL(rel, import.meta.url).pathname;

// Resolve workspace packages to their TypeScript source so the dev server and
// build transpile them directly (no separate library build step).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@libclaude/react": src("../../packages/react/src/index.ts"),
      "@libclaude/rpc/ws-client": src("../../packages/rpc/src/transports/websocket-client.ts"),
      "@libclaude/rpc": src("../../packages/rpc/src/index.ts"),
      "@libclaude/core/types": src("../../packages/core/src/types.ts"),
      "@libclaude/core": src("../../packages/core/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy the RPC WebSocket to the backend during development.
      "/ws": { target: "ws://localhost:4000", ws: true },
      "/health": { target: "http://localhost:4000" },
    },
  },
});
