/**
 * Event types emitted by the `claude` CLI in stream-json mode.
 * Sourced from ~/code/libclaude/packages/core/src/types.ts
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

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  [k: string]: unknown;
}

export interface AssistantEvent {
  type: "assistant";
  session_id?: string;
  message: { role: "assistant"; content: ContentBlock[]; [k: string]: unknown };
}

export interface UserEvent {
  type: "user";
  session_id?: string;
  message: { role: "user"; content: ContentBlock[] | string; [k: string]: unknown };
}

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

export interface TurnResult {
  ok: boolean;
  result: string;
  sessionId: string | null;
  isError: boolean;
  subtype?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  events: ClaudeEvent[];
}

export type PermissionMode = "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface SessionOptions {
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  claudeBin?: string;
  extraArgs?: string[];
  env?: Record<string, string | undefined>;
  maxCrashes?: number;
}

export interface SessionStatus {
  ready: boolean;
  busy: boolean;
  queued: number;
  sessionId: string | null;
  pid: number | null;
}
