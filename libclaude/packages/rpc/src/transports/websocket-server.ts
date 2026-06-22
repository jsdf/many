import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { ServerConnection, ServerTransport } from "../transport.ts";
import type { ClientMessage, ServerMessage } from "../wire.ts";

export interface WebSocketServerOptions {
  /** Attach to an existing HTTP server (so HTTP + WS share one port). */
  server?: HttpServer;
  /** Listen on this path. Default "/ws". */
  path?: string;
  /**
   * Validate each upgrade. Return false to reject (401). Useful for token auth.
   * Receives the upgrade URL and headers.
   */
  authenticate?: (url: URL, headers: Record<string, string | string[] | undefined>) => boolean;
}

/**
 * `ws`-backed {@link ServerTransport}. Handles the HTTP upgrade itself (with
 * optional auth) so it can co-exist with a static/HTTP server on one port,
 * mirroring the mux server's `noServer` upgrade handling.
 */
export class WebSocketServerTransport implements ServerTransport {
  private readonly wss: WebSocketServer;
  private connectionCb: ((conn: ServerConnection) => void) | null = null;

  constructor(options: WebSocketServerOptions = {}) {
    const path = options.path ?? "/ws";
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (ws: WebSocket) => {
      this.connectionCb?.(new WsConnection(ws));
    });

    if (options.server) {
      options.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "", `http://${req.headers.host}`);
        if (url.pathname !== path) return; // let other upgrade handlers have it
        if (options.authenticate && !options.authenticate(url, req.headers)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      });
    }
  }

  onConnection(cb: (conn: ServerConnection) => void): void {
    this.connectionCb = cb;
  }
}

class WsConnection implements ServerConnection {
  constructor(private readonly ws: WebSocket) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(cb: (msg: ClientMessage) => void): void {
    this.ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      cb(msg);
    });
  }

  onClose(cb: () => void): void {
    this.ws.on("close", cb);
  }
}
