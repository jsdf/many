/**
 * Event types emitted by the `claude` CLI in stream-json mode.
 *
 * These mirror the shapes the CLI writes to stdout when run with
 * `--output-format stream-json --verbose`. We keep them loose (raw passthrough
 * plus the fields we rely on) rather than exhaustively typing every block: the
 * CLI owns this schema and adds fields over time.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

/** `{type:"system", subtype:"init", ...}` emitted once per session start. */
export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  [k: string]: unknown;
}

/** An assistant turn (text and/or tool_use blocks). */
export interface AssistantEvent {
  type: "assistant";
  session_id?: string;
  message: { role: "assistant"; content: ContentBlock[]; [k: string]: unknown };
}

/** A user turn — in practice tool_result blocks fed back into the model. */
export interface UserEvent {
  type: "user";
  session_id?: string;
  message: { role: "user"; content: ContentBlock[] | string; [k: string]: unknown };
}

/** Terminal event for a turn. */
export interface ResultEvent {
  type: "result";
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  [k: string]: unknown;
}

export type ClaudeEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | { type: string; session_id?: string; [k: string]: unknown };

/** Buffered summary of a single completed turn. */
export interface TurnResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  subtype?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  /** Every raw event observed during the turn, in order. */
  events: ClaudeEvent[];
}

export type PermissionMode = "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions";

/**
 * Optional sink for the session's diagnostic logging (process lifecycle,
 * stderr from the `claude` child, dropped output). Each level is optional so a
 * caller can wire only the levels it cares about. Defaults to no-op.
 */
export interface SessionLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface SessionOptions {
  /** Working directory the agent operates in. Defaults to process.cwd(). */
  cwd?: string;
  /** `--model`. Defaults to the CLI's own default. */
  model?: string;
  /** `--permission-mode`. Defaults to "auto". */
  permissionMode?: PermissionMode;
  /** Path to the claude binary, or a shell command/alias when `loginShell` is
   *  set. Defaults to "claude". */
  claudeBin?: string;
  /** Run `claudeBin` through an interactive login shell so aliases, shell
   *  functions, and rc-defined PATH/env resolve. Defaults to false (direct
   *  spawn). Use when `claudeBin` may be an alias or a command with args. */
  loginShell?: boolean;
  /** Shell used when `loginShell` is set. Defaults to $SHELL or /bin/bash. */
  shell?: string;
  /** Extra CLI flags appended verbatim, e.g. ["--add-dir", "/data"]. */
  extraArgs?: string[];
  /** Environment for the child process. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Max consecutive crashes before the session stops respawning. Default 5. */
  maxCrashes?: number;
  /** Diagnostic logger for process lifecycle and the child's stderr. */
  logger?: SessionLogger;
}

export interface SessionStatus {
  ready: boolean;
  busy: boolean;
  queued: number;
  sessionId: string | null;
  pid: number | null;
}
