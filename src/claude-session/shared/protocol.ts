/**
 * Shared RPC protocol for claude-session.
 * Mux-style: typed queries and subscriptions over a single WebSocket.
 */

import type { UUID } from "crypto";

// ---------------------------------------------------------------------------
// Domain types  (UI-facing, simplified from raw SDK messages)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
  createdAt?: number;
  /** Whether a live query() is running for this session */
  isActive: boolean;
}

/** Roles visible in the UI */
export type MessageRole = "user" | "assistant" | "system";

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  output: string;
  isError: boolean;
}

/** A single content block inside a message */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; toolUse: ToolUse }
  | { type: "tool_result"; toolResult: ToolResult };

export interface SessionMessage {
  id: string; // uuid
  role: MessageRole;
  content: ContentBlock[];
  timestamp: number | null;
  /** For assistant messages that errored */
  error?: string;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "compacting"
  | "error";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  displayName?: string;
}

/** Streamed to subscription clients as the session runs */
export type SessionEvent =
  | { type: "message"; message: SessionMessage }
  | { type: "message_delta"; messageId: string; content: ContentBlock[] }
  | { type: "status"; status: SessionStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "result"; result: SessionResult }
  | { type: "tool_progress"; toolUseId: string; toolName: string; elapsed: number }
  | { type: "error"; error: string };

export interface SessionResult {
  isError: boolean;
  durationMs: number;
  totalCostUsd: number;
  numTurns: number;
}

// ---------------------------------------------------------------------------
// RPC procedure definitions
// ---------------------------------------------------------------------------

/**
 * Queries: one-shot request → response
 */
export interface QueryProcedures {
  /** List sessions for a directory (worktree) */
  "session.list": {
    input: { dir: string; limit?: number; offset?: number };
    output: SessionInfo[];
  };
  /** Get messages for a (possibly historical) session */
  "session.messages": {
    input: { sessionId: string; dir?: string; limit?: number; offset?: number };
    output: { messages: SessionMessage[]; hasMore: boolean };
  };
  /** Start a new session or resume an existing one */
  "session.start": {
    input: {
      cwd: string;
      prompt?: string;
      sessionId?: string; // resume
      permissionMode?: string;
    };
    output: { sessionId: string };
  };
  /** Send a follow-up message to a running session */
  "session.send": {
    input: { sessionId: string; message: string };
    output: { ok: boolean };
  };
  /** Respond to a permission request */
  "session.permission": {
    input: {
      sessionId: string;
      requestId: string;
      allow: boolean;
      /** If true, remember this permission for the session */
      remember?: boolean;
    };
    output: { ok: boolean };
  };
  /** Interrupt a running session */
  "session.interrupt": {
    input: { sessionId: string };
    output: { ok: boolean };
  };
  /** Close / stop a session */
  "session.close": {
    input: { sessionId: string };
    output: { ok: boolean };
  };
}

/**
 * Subscriptions: long-lived push from server
 */
export interface SubscriptionProcedures {
  /** Stream of events for a session (live or replaying history) */
  "session.events": {
    input: { sessionId: string };
    output: SessionEvent;
  };
  /** Session list updates (sessions added/removed/changed) */
  "session.list.updates": {
    input: { dir: string };
    output: SessionInfo[];
  };
}

// ---------------------------------------------------------------------------
// Wire protocol (mux-style)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { id: number; type: "query"; procedure: string; input: unknown }
  | { id: number; type: "subscribe"; procedure: string; input: unknown }
  | { id: number; type: "unsubscribe" };

export type ServerMessage =
  | { id: number; type: "result"; data: unknown }
  | { id: number; type: "data"; data: unknown }
  | { id: number; type: "error"; error: string };

// ---------------------------------------------------------------------------
// Type helpers (mux pattern: conditional type extraction)
// ---------------------------------------------------------------------------

export type QueryProcedure = keyof QueryProcedures;
export type SubscriptionProcedure = keyof SubscriptionProcedures;
export type Procedure = QueryProcedure | SubscriptionProcedure;

export type ProcedureInput<K extends Procedure> = K extends QueryProcedure
  ? QueryProcedures[K]["input"]
  : K extends SubscriptionProcedure
    ? SubscriptionProcedures[K]["input"]
    : never;

export type ProcedureOutput<K extends Procedure> = K extends QueryProcedure
  ? QueryProcedures[K]["output"]
  : K extends SubscriptionProcedure
    ? SubscriptionProcedures[K]["output"]
    : never;
