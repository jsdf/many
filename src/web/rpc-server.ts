/**
 * Generic mux-style WebSocket RPC server.
 * Handles typed queries and subscriptions over a single WebSocket connection.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import logger from "../shared/logger.js";
import type {
  ClientMessage,
  ServerMessage,
  QueryProcedure,
  SubscriptionProcedure,
} from "../shared/protocol.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryHandler = (input: unknown) => Promise<unknown>;

/**
 * A subscription handler receives input and a push function.
 * It may return a cleanup function to be called on unsubscribe.
 */
export type SubscriptionHandler = (
  input: unknown,
  push: (data: unknown) => void
) => (() => void) | void;

interface Subscription {
  procedure: string;
  cleanup?: () => void;
}

export interface RpcServerOptions {
  /** Pass server+path for auto upgrade, or omit for noServer mode */
  server?: HttpServer;
  path?: string;
  token: string;
  queryHandlers: Partial<Record<QueryProcedure, QueryHandler>>;
  subscriptionHandlers: Partial<
    Record<SubscriptionProcedure, SubscriptionHandler>
  >;
  /** Use noServer mode (caller handles upgrade manually) */
  noServer?: boolean;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class RpcServer {
  private wss: WebSocketServer;
  private subscriptions = new Map<WebSocket, Map<number, Subscription>>();
  private token: string;
  private queryHandlers: Partial<Record<string, QueryHandler>>;
  private subscriptionHandlers: Partial<Record<string, SubscriptionHandler>>;

  constructor(opts: RpcServerOptions) {
    this.token = opts.token;
    this.queryHandlers = opts.queryHandlers;
    this.subscriptionHandlers = opts.subscriptionHandlers;

    if (opts.noServer) {
      this.wss = new WebSocketServer({ noServer: true });
    } else {
      this.wss = new WebSocketServer({ server: opts.server, path: opts.path });
    }

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

  /** Handle WebSocket upgrade (for noServer mode) */
  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  /** Broadcast data to all subscribers of a given procedure that match a filter */
  broadcast(
    procedure: SubscriptionProcedure,
    data: unknown,
    filter?: (input: unknown) => boolean
  ): void {
    for (const [ws, subs] of this.subscriptions) {
      for (const [id, sub] of subs) {
        if (sub.procedure === procedure) {
          // filter is optional — if provided, we'd need to store the input.
          // For simplicity, broadcast to all subscribers of this procedure.
          this.send(ws, { id, type: "data", data });
        }
      }
    }
  }

  /** Get count of connected clients */
  get clientCount(): number {
    return this.subscriptions.size;
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
        await this.handleQuery(ws, msg.id, msg.procedure, msg.input);
        break;
      case "subscribe":
        this.handleSubscribe(ws, msg.id, msg.procedure, msg.input);
        break;
      case "unsubscribe":
        this.handleUnsubscribe(ws, msg.id);
        break;
    }
  }

  private async handleQuery(
    ws: WebSocket,
    id: number,
    procedure: string,
    input: unknown
  ): Promise<void> {
    const handler = this.queryHandlers[procedure];
    if (!handler) {
      logger.warn(`Unknown query procedure: ${procedure}`);
      this.send(ws, {
        id,
        type: "error",
        error: `Unknown query procedure: ${procedure}`,
      });
      return;
    }

    logger.debug(`[rpc] query ${procedure}`, input);
    try {
      const result = await handler(input);
      this.send(ws, { id, type: "result", data: result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[rpc] query ${procedure} failed:`, errMsg);
      this.send(ws, { id, type: "error", error: errMsg });
    }
  }

  private handleSubscribe(
    ws: WebSocket,
    id: number,
    procedure: string,
    input: unknown
  ): void {
    const clientSubs = this.subscriptions.get(ws);
    if (!clientSubs) return;

    const handler = this.subscriptionHandlers[procedure];
    if (!handler) {
      logger.warn(`Unknown subscription procedure: ${procedure}`);
      this.send(ws, {
        id,
        type: "error",
        error: `Unknown subscription procedure: ${procedure}`,
      });
      return;
    }

    logger.debug(`[rpc] subscribe ${procedure}`, input);
    const push = (data: unknown) => {
      this.send(ws, { id, type: "data", data });
    };

    try {
      const cleanup = handler(input, push);
      clientSubs.set(id, {
        procedure,
        cleanup: cleanup ?? undefined,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[rpc] subscribe ${procedure} failed:`, errMsg);
      this.send(ws, { id, type: "error", error: errMsg });
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
