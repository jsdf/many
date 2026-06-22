/**
 * Transport-agnostic RPC wire format and procedure typing.
 *
 * The wire types carry no procedure-specific typing — they are what every
 * transport ships over the channel. Type safety for individual procedures is
 * layered on top by {@link RpcClient}/{@link RpcServer}, which are generic over
 * a {@link AnyProcedures} map (see protocol.ts for the concrete one).
 */

export type ProcedureKind = "query" | "subscription";

export interface ProcedureDef<
  K extends ProcedureKind = ProcedureKind,
  I = unknown,
  O = unknown,
> {
  type: K;
  input: I;
  output: O;
}

export type AnyProcedures = Record<string, ProcedureDef>;

// ---- Wire messages ----

export type ClientMessage =
  | { id: number; type: "query"; procedure: string; input: unknown }
  | { id: number; type: "subscribe"; procedure: string; input: unknown }
  | { id: number; type: "unsubscribe" };

export type ServerMessage =
  | { id: number; type: "result"; data: unknown }
  | { id: number; type: "data"; data: unknown }
  | { id: number; type: "error"; error: string };

// ---- Helpers for deriving typed call signatures from a procedure map ----

export type QueryProcedure<P extends AnyProcedures> = {
  [K in keyof P]: P[K]["type"] extends "query" ? K : never;
}[keyof P];

export type SubscriptionProcedure<P extends AnyProcedures> = {
  [K in keyof P]: P[K]["type"] extends "subscription" ? K : never;
}[keyof P];

/** A procedure with `input: void` is callable with no argument. */
export type ProcedureInput<P extends AnyProcedures, K extends keyof P> =
  P[K]["input"] extends void ? [] : [P[K]["input"]];

export type ProcedureOutput<P extends AnyProcedures, K extends keyof P> = P[K]["output"];
