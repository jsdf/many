import type { ClientTransport } from "./transport.ts";
import type {
  AnyProcedures,
  ProcedureInput,
  ProcedureOutput,
  QueryProcedure,
  ServerMessage,
  SubscriptionProcedure,
} from "./wire.ts";

export type Unsubscribe = () => void;

/**
 * Transport-pluggable typed RPC client. Generic over a procedure map so a single
 * implementation serves any protocol; pair it with a {@link ClientTransport}.
 *
 *   const rpc = new RpcClient<Procedures>(new WebSocketClientTransport(url));
 *   const status = rpc.subscribe("status", (s) => ...);
 *   const r = await rpc.query("reset");
 */
export class RpcClient<P extends AnyProcedures> {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly subscriptions = new Map<number, (data: unknown) => void>();
  private readonly subscriptionInputs = new Map<number, { procedure: string; input: unknown }>();

  constructor(private readonly transport: ClientTransport) {
    transport.onMessage((msg) => this.handleMessage(msg));
    transport.onOpen(() => this.resubscribe());
    transport.onClose(() => this.rejectPending());
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg.data);
      }
    } else if (msg.type === "data") {
      this.subscriptions.get(msg.id)?.(msg.data);
    } else if (msg.type === "error") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(new Error(msg.error));
      }
    }
  }

  private resubscribe(): void {
    for (const id of this.subscriptions.keys()) {
      const sub = this.subscriptionInputs.get(id);
      if (sub) {
        this.transport.send({ id, type: "subscribe", procedure: sub.procedure, input: sub.input });
      }
    }
  }

  private rejectPending(): void {
    for (const [, p] of this.pending) p.reject(new Error("connection closed"));
    this.pending.clear();
  }

  query<K extends QueryProcedure<P>>(
    procedure: K,
    ...args: ProcedureInput<P, K>
  ): Promise<ProcedureOutput<P, K>> {
    const id = this.nextId++;
    const input = (args[0] ?? null) as unknown;
    return new Promise<ProcedureOutput<P, K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
      this.transport.send({ id, type: "query", procedure: String(procedure), input });
    });
  }

  subscribe<K extends SubscriptionProcedure<P>>(
    procedure: K,
    callback: (data: ProcedureOutput<P, K>) => void,
    ...args: ProcedureInput<P, K>
  ): Unsubscribe {
    const id = this.nextId++;
    const input = (args[0] ?? null) as unknown;
    this.subscriptions.set(id, callback as (d: unknown) => void);
    this.subscriptionInputs.set(id, { procedure: String(procedure), input });
    this.transport.send({ id, type: "subscribe", procedure: String(procedure), input });

    return () => {
      this.subscriptions.delete(id);
      this.subscriptionInputs.delete(id);
      this.transport.send({ id, type: "unsubscribe" });
    };
  }

  destroy(): void {
    this.transport.close();
  }
}
