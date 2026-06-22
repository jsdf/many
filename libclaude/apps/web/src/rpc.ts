import { RpcClient, type Procedures } from "@libclaude/rpc";
import { WebSocketClientTransport } from "@libclaude/rpc/ws-client";

// Same-origin WebSocket; Vite proxies /ws to the backend in dev, and the backend
// serves this app + /ws on one port in production. Token (if any) comes from the
// URL query string, matching the backend's token-on-upgrade auth.
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(window.location.search).get("token");
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${window.location.host}/ws${query}`;
}

export const rpc = new RpcClient<Procedures>(new WebSocketClientTransport(wsUrl()));
