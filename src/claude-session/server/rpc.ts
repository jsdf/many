/**
 * WebSocket RPC server for claude-session.
 * Mux-style: queries and subscriptions over a single WebSocket connection.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";

import type {
  ClientMessage,
  ServerMessage,
  QueryProcedure,
  SubscriptionProcedure,
  SessionEvent,
  SessionInfo,
} from "../shared/protocol.js";
import { ClaudeService } from "./claude-service.js";
import { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Subscription {
  procedure: SubscriptionProcedure;
  cleanup?: () => void;
}

// ---------------------------------------------------------------------------
// RPC Server
// ---------------------------------------------------------------------------

export class ClaudeSessionRpc {
  private wss: WebSocketServer;
  private claudeService: ClaudeService;
  private sessionStore: SessionStore;
  private subscriptions = new Map<WebSocket, Map<number, Subscription>>();
  private token: string;

  constructor(opts: {
    server: HttpServer;
    path: string;
    token: string;
    claudeService: ClaudeService;
    sessionStore: SessionStore;
  }) {
    this.claudeService = opts.claudeService;
    this.sessionStore = opts.sessionStore;
    this.token = opts.token;

    this.wss = new WebSocketServer({ server: opts.server, path: opts.path });

    this.wss.on("connection", (ws, req) => {
      if (!this.authenticate(req)) {
        ws.close(4001, "Unauthorized");
        return;
      }

      this.subscriptions.set(ws, new Map());

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          this.handleMessage(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        this.cleanupClient(ws);
      });
    });
  }

  /** Broadcast session list update to all subscribers watching a dir */
  async broadcastSessionList(dir: string): Promise<void> {
    const sessions = await this.sessionStore.listSessions({ dir });
    // Overlay active status
    for (const s of sessions) {
      s.isActive = this.claudeService.isActive(s.sessionId);
    }

    for (const [ws, subs] of this.subscriptions) {
      for (const [id, sub] of subs) {
        if (sub.procedure === "session.list.updates") {
          this.send(ws, { id, type: "data", data: sessions });
        }
      }
    }
  }

  destroy(): void {
    for (const ws of this.subscriptions.keys()) {
      this.cleanupClient(ws);
    }
    this.wss.close();
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private async handleMessage(
    ws: WebSocket,
    msg: ClientMessage
  ): Promise<void> {
    switch (msg.type) {
      case "query":
        await this.handleQuery(ws, msg.id, msg.procedure as QueryProcedure, msg.input);
        break;
      case "subscribe":
        this.handleSubscribe(ws, msg.id, msg.procedure as SubscriptionProcedure, msg.input);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(ws, msg.id);
        break;
    }
  }

  private async handleQuery(
    ws: WebSocket,
    id: number,
    procedure: QueryProcedure,
    input: unknown
  ): Promise<void> {
    try {
      let result: unknown;

      switch (procedure) {
        case "session.list": {
          const inp = input as { dir: string; limit?: number; offset?: number };
          const sessions = await this.sessionStore.listSessions(inp);
          // Overlay active status
          for (const s of sessions) {
            s.isActive = this.claudeService.isActive(s.sessionId);
          }
          result = sessions;
          break;
        }

        case "session.messages": {
          const inp = input as {
            sessionId: string;
            dir?: string;
            limit?: number;
            offset?: number;
          };
          result = await this.sessionStore.getMessages(inp);
          break;
        }

        case "session.start": {
          const inp = input as {
            cwd: string;
            prompt?: string;
            sessionId?: string;
            permissionMode?: string;
          };
          const sessionId = await this.claudeService.start({
            cwd: inp.cwd,
            prompt: inp.prompt,
            sessionId: inp.sessionId,
            permissionMode: (inp.permissionMode ?? "bypassPermissions") as any,
          });
          result = { sessionId };
          break;
        }

        case "session.send": {
          const inp = input as { sessionId: string; message: string };
          await this.claudeService.send(inp.sessionId, inp.message);
          result = { ok: true };
          break;
        }

        case "session.permission": {
          const inp = input as {
            sessionId: string;
            requestId: string;
            allow: boolean;
          };
          this.claudeService.resolvePermission(
            inp.sessionId,
            inp.requestId,
            inp.allow
          );
          result = { ok: true };
          break;
        }

        case "session.interrupt": {
          const inp = input as { sessionId: string };
          await this.claudeService.interrupt(inp.sessionId);
          result = { ok: true };
          break;
        }

        case "session.close": {
          const inp = input as { sessionId: string };
          this.claudeService.close(inp.sessionId);
          result = { ok: true };
          break;
        }

        default:
          throw new Error(`Unknown query procedure: ${procedure}`);
      }

      this.send(ws, { id, type: "result", data: result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.send(ws, { id, type: "error", error: errMsg });
    }
  }

  private handleSubscribe(
    ws: WebSocket,
    id: number,
    procedure: SubscriptionProcedure,
    input: unknown
  ): void {
    const clientSubs = this.subscriptions.get(ws);
    if (!clientSubs) return;

    switch (procedure) {
      case "session.events": {
        const inp = input as { sessionId: string };
        const cleanup = this.claudeService.subscribe(
          inp.sessionId,
          (event: SessionEvent) => {
            this.send(ws, { id, type: "data", data: event });
          }
        );
        clientSubs.set(id, { procedure, cleanup });
        break;
      }

      case "session.list.updates": {
        // Just register — updates are pushed via broadcastSessionList()
        clientSubs.set(id, { procedure });

        // Send initial data
        const inp = input as { dir: string };
        this.sessionStore
          .listSessions({ dir: inp.dir })
          .then((sessions) => {
            for (const s of sessions) {
              s.isActive = this.claudeService.isActive(s.sessionId);
            }
            this.send(ws, { id, type: "data", data: sessions });
          })
          .catch(() => {});
        break;
      }
    }
  }

  private handleUnsubscribe(ws: WebSocket, id: number): void {
    const clientSubs = this.subscriptions.get(ws);
    if (!clientSubs) return;

    const sub = clientSubs.get(id);
    if (sub?.cleanup) sub.cleanup();
    clientSubs.delete(id);
  }

  private cleanupClient(ws: WebSocket): void {
    const subs = this.subscriptions.get(ws);
    if (subs) {
      for (const sub of subs.values()) {
        if (sub.cleanup) sub.cleanup();
      }
      subs.clear();
    }
    this.subscriptions.delete(ws);
  }

  private authenticate(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("token") === this.token;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
