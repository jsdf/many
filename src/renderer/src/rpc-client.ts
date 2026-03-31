/**
 * Singleton WebSocket RPC client for the many renderer.
 * Mux-style: typed queries and subscriptions over a single WebSocket.
 */

import type {
  ClientMessage,
  ServerMessage,
  QueryProcedure,
  SubscriptionProcedure,
  ProcedureInput,
  ProcedureOutput,
} from "../../shared/protocol";

type PendingQuery = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
};

type ActiveSubscription = {
  procedure: SubscriptionProcedure;
  input: unknown;
  callback: (data: unknown) => void;
};

class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingQuery>();
  private subscriptions = new Map<number, ActiveSubscription>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue: ClientMessage[] = [];
  private url: string;
  private destroyed = false;
  private hasConnected = false;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  query<K extends QueryProcedure>(
    procedure: K,
    input: ProcedureInput<K>
  ): Promise<ProcedureOutput<K>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
      });
      this.send({ id, type: "query", procedure, input });
    });
  }

  subscribe<K extends SubscriptionProcedure>(
    procedure: K,
    callback: (data: ProcedureOutput<K>) => void,
    input: ProcedureInput<K>
  ): () => void {
    const id = this.nextId++;
    this.subscriptions.set(id, {
      procedure,
      input,
      callback: callback as (data: unknown) => void,
    });
    this.send({ id, type: "subscribe", procedure, input });

    return () => {
      this.send({ id, type: "unsubscribe" });
      this.subscriptions.delete(id);
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    for (const p of this.pending.values()) {
      p.reject(new Error("Client destroyed"));
    }
    this.pending.clear();
    this.subscriptions.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      if (this.hasConnected) {
        // Reconnect: re-subscribe to active subscriptions
        for (const [id, sub] of this.subscriptions) {
          this.send({
            id,
            type: "subscribe",
            procedure: sub.procedure,
            input: sub.input,
          });
        }
      }
      this.hasConnected = true;
      // Flush queued messages in original order
      const queued = this.sendQueue.splice(0);
      for (const msg of queued) {
        this.send(msg);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 1000);
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (p) {
        p.resolve(msg.data);
        this.pending.delete(msg.id);
      }
    } else if (msg.type === "data") {
      const sub = this.subscriptions.get(msg.id);
      if (sub) {
        sub.callback(msg.data);
      }
    } else if (msg.type === "error") {
      const p = this.pending.get(msg.id);
      if (p) {
        p.reject(new Error(msg.error));
        this.pending.delete(msg.id);
      }
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      // Queue messages sent before WebSocket is open
      this.sendQueue.push(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let client: RpcClient | null = null;

export function getRpcClient(): RpcClient {
  if (!client) {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") ?? "";
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProtocol}//${window.location.host}/ws?token=${token}`;
    client = new RpcClient(url);
  }
  return client;
}

export type { RpcClient };
