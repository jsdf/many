import type { ServerConnection, ServerTransport } from "./transport.ts";
import type { AnyProcedures, ClientMessage } from "./wire.ts";

type Cleanup = () => void;

export type QueryHandler<P extends AnyProcedures, K extends keyof P> = (
  input: P[K]["input"],
) => Promise<P[K]["output"]> | P[K]["output"];

export type SubscribeHandler<P extends AnyProcedures, K extends keyof P> = (
  input: P[K]["input"],
  push: (data: P[K]["output"]) => void,
) => Cleanup | void | Promise<Cleanup | void>;

/**
 * Transport-pluggable typed RPC server. Register one handler per procedure, then
 * bind to a {@link ServerTransport}. Query handlers return a value; subscription
 * handlers push values over time and return a cleanup function.
 */
type AnyQueryHandler = (input: unknown) => Promise<unknown> | unknown;
type AnySubscribeHandler = (
  input: unknown,
  push: (data: unknown) => void,
) => Cleanup | void | Promise<Cleanup | void>;

export class RpcServer<P extends AnyProcedures> {
  private readonly queries = new Map<string, AnyQueryHandler>();
  private readonly subs = new Map<string, AnySubscribeHandler>();

  query<K extends keyof P>(procedure: K, handler: QueryHandler<P, K>): this {
    this.queries.set(String(procedure), handler as AnyQueryHandler);
    return this;
  }

  subscription<K extends keyof P>(procedure: K, handler: SubscribeHandler<P, K>): this {
    this.subs.set(String(procedure), handler as AnySubscribeHandler);
    return this;
  }

  /** Start accepting connections from the transport. */
  bind(transport: ServerTransport): void {
    transport.onConnection((conn) => this.handleConnection(conn));
  }

  private handleConnection(conn: ServerConnection): void {
    const active = new Map<number, Cleanup>();

    conn.onMessage(async (msg: ClientMessage) => {
      if (msg.type === "query") {
        const handler = this.queries.get(msg.procedure);
        if (!handler) {
          conn.send({ id: msg.id, type: "error", error: `unknown query: ${msg.procedure}` });
          return;
        }
        try {
          const data = await handler(msg.input);
          conn.send({ id: msg.id, type: "result", data });
        } catch (err) {
          conn.send({ id: msg.id, type: "error", error: errMessage(err) });
        }
      } else if (msg.type === "subscribe") {
        const handler = this.subs.get(msg.procedure);
        if (!handler) {
          conn.send({ id: msg.id, type: "error", error: `unknown subscription: ${msg.procedure}` });
          return;
        }
        // A re-subscribe on the same id replaces the prior one.
        active.get(msg.id)?.();
        active.delete(msg.id);
        try {
          const push = (data: unknown) => conn.send({ id: msg.id, type: "data", data });
          const cleanup = await handler(msg.input, push);
          if (typeof cleanup === "function") active.set(msg.id, cleanup);
        } catch (err) {
          conn.send({ id: msg.id, type: "error", error: errMessage(err) });
        }
      } else if (msg.type === "unsubscribe") {
        active.get(msg.id)?.();
        active.delete(msg.id);
      }
    });

    conn.onClose(() => {
      for (const cleanup of active.values()) cleanup();
      active.clear();
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
