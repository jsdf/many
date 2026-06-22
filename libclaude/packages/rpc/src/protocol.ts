import type { ClaudeEvent, SessionStatus, TurnResult } from "@libclaude/core/types";
import type { ProcedureDef } from "./wire.ts";

export type { ClaudeEvent, SessionStatus, TurnResult };

/** One streamed update from a turn subscription. */
export type TurnUpdate =
  | { kind: "event"; event: ClaudeEvent }
  | { kind: "done"; result: TurnResult };

/**
 * The concrete RPC contract between the libclaude web UI and the backend that
 * owns a {@link ClaudeSession}. Shared verbatim by client and server so a change
 * here is a type error on both sides.
 */
export type Procedures = {
  /** Live session status (ready/busy/queue/sessionId). Pushes on every change. */
  status: ProcedureDef<"subscription", void, SessionStatus>;
  /**
   * Run one prompt as a turn and stream its events. Emits a "done" update with
   * the buffered result when the turn completes. Unsubscribing interrupts it.
   */
  turn: ProcedureDef<"subscription", { prompt: string }, TurnUpdate>;
  /** Restart the underlying claude process with a fresh conversation. */
  reset: ProcedureDef<"query", void, { ok: true }>;
  /** Best-effort interrupt of the in-flight turn. */
  interrupt: ProcedureDef<"query", void, { ok: true }>;
};
