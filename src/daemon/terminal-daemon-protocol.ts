/**
 * Wire protocol + framing for the terminal daemon IPC.
 *
 * Transport: a Node `net` socket over a Unix domain socket (macOS/Linux) or a
 * Windows named pipe. Messages are length-prefixed: a 4-byte big-endian uint32
 * byte length, followed by that many bytes of UTF-8 JSON. PTY data flows as
 * JSON strings (same as over the websocket today), so no base64 needed.
 */

import type { TerminalEvent, ClaudeUiEvent, ClaudeUiPermissionMode } from "../shared/protocol.js";
import type { TerminalSessionInfo } from "../web/terminal-manager.js";

export const DAEMON_PROTOCOL_VERSION = 3;

/** Agent info as sent over the wire (mirrors ClaudeAgentManager's AgentInfo). */
export interface AgentInfoWire {
  agentId: string;
  worktreePath: string;
  sessionId: string | null;
  title?: string;
}

export type AgentEvent = { type: "agent"; event: ClaudeUiEvent };

/** Claude UI session info as sent over the wire (mirrors ClaudeUiManager's info). */
export interface ClaudeUiInfoWire {
  sessionId: string;
  worktreePath: string;
  title?: string;
}

export type ClaudeUiWireEvent = { type: "claudeUi"; event: ClaudeUiEvent };

/** Metadata for a session saved to a log file (mirrors TerminalManager.saveAllSessionLogs). */
export interface SavedSessionLog {
  terminalId: string;
  worktreePath: string;
  logFile: string;
}

// ---------------------------------------------------------------------------
// Requests (client -> daemon). Each carries a reqId for response correlation.
// ---------------------------------------------------------------------------

export type DaemonRequest =
  | {
      reqId: number;
      op: "createSession";
      terminalId: string;
      worktreePath: string;
      cols: number;
      rows: number;
      extraEnv?: Record<string, string>;
      initialCommand?: string;
      logDir?: string | null;
      taskId?: string;
    }
  | { reqId: number; op: "input"; terminalId: string; data: string }
  | { reqId: number; op: "resize"; terminalId: string; cols: number; rows: number }
  | { reqId: number; op: "close"; terminalId: string }
  | { reqId: number; op: "getSessionPid"; terminalId: string }
  | { reqId: number; op: "listSessions"; worktreePath: string }
  | { reqId: number; op: "listAll" }
  | { reqId: number; op: "counts" }
  | { reqId: number; op: "cleanupWorktree"; worktreePath: string }
  | { reqId: number; op: "getBufferedOutput"; terminalId: string }
  | { reqId: number; op: "saveAllSessionLogs"; logDir: string }
  | { reqId: number; op: "setLabel"; terminalId: string; label: string }
  | { reqId: number; op: "shutdown" }
  | { reqId: number; op: "ping" }
  | { reqId: number; op: "subscribe"; terminalId: string; subId: number }
  | { reqId: number; op: "subscribeExit"; terminalId: string; subId: number }
  | { reqId: number; op: "unsubscribe"; subId: number }
  | {
      reqId: number;
      op: "agentCreate";
      agentId: string;
      worktreePath: string;
      prompt?: string;
      claudeBin?: string;
    }
  | { reqId: number; op: "agentSend"; agentId: string; message: string }
  | { reqId: number; op: "agentSubscribe"; agentId: string; subId: number }
  | { reqId: number; op: "agentList" }
  | { reqId: number; op: "claudeUiCreate"; sessionId: string; worktreePath: string; claudeBin?: string }
  | {
      reqId: number;
      op: "claudeUiResume";
      sessionId: string;
      worktreePath: string;
      seed: ClaudeUiEvent[];
      title?: string;
      firstPrompt?: string;
      claudeBin?: string;
    }
  | { reqId: number; op: "claudeUiSend"; sessionId: string; prompt: string }
  | { reqId: number; op: "claudeUiList"; worktreePath: string }
  | { reqId: number; op: "claudeUiListAll" }
  | { reqId: number; op: "claudeUiSetPermissionMode"; sessionId: string; mode: ClaudeUiPermissionMode }
  | { reqId: number; op: "claudeUiInterrupt"; sessionId: string }
  | { reqId: number; op: "claudeUiReset"; sessionId: string }
  | { reqId: number; op: "claudeUiClose"; sessionId: string }
  | { reqId: number; op: "claudeUiSubscribe"; sessionId: string; subId: number };

export type DaemonOp = DaemonRequest["op"];

// ---------------------------------------------------------------------------
// Response payloads, keyed by op.
// ---------------------------------------------------------------------------

export interface DaemonResultMap {
  createSession: { existed: boolean; pid: number | null };
  input: { ok: true };
  resize: { ok: true };
  close: { ok: true };
  getSessionPid: { pid: number | null };
  listSessions: { ids: string[] };
  listAll: { sessions: TerminalSessionInfo[] };
  counts: { counts: Record<string, number> };
  cleanupWorktree: { ok: true };
  getBufferedOutput: { output: string };
  saveAllSessionLogs: { saved: SavedSessionLog[] };
  setLabel: { ok: true };
  shutdown: { ok: true };
  ping: { ok: true; version: number };
  subscribe: { ok: true };
  subscribeExit: { ok: true };
  unsubscribe: { ok: true };
  agentCreate: { agent: AgentInfoWire };
  agentSend: { ok: true };
  agentSubscribe: { ok: true };
  agentList: { agents: AgentInfoWire[] };
  claudeUiCreate: { session: ClaudeUiInfoWire };
  claudeUiResume: { session: ClaudeUiInfoWire };
  claudeUiSend: { ok: true };
  claudeUiList: { sessions: ClaudeUiInfoWire[] };
  claudeUiListAll: { sessions: ClaudeUiInfoWire[] };
  claudeUiSetPermissionMode: { ok: true };
  claudeUiInterrupt: { ok: true };
  claudeUiReset: { ok: true };
  claudeUiClose: { ok: true };
  claudeUiSubscribe: { ok: true };
}

// ---------------------------------------------------------------------------
// Messages (daemon -> client).
// ---------------------------------------------------------------------------

export type DaemonMessage =
  | { type: "response"; reqId: number; result: unknown }
  | { type: "response"; reqId: number; error: string }
  | { type: "event"; subId: number; event: TerminalEvent | AgentEvent | ClaudeUiWireEvent };

// ---------------------------------------------------------------------------
// Length-prefix framing
// ---------------------------------------------------------------------------

/** Encode any JSON-serializable message into a length-prefixed frame buffer. */
export function encodeFrame(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Incremental decoder for the length-prefix framing. Feed it raw socket chunks
 * via `push`; it returns the complete messages contained in the buffer so far,
 * retaining any partial trailing frame for the next chunk.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const messages: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      messages.push(JSON.parse(json));
    }
    return messages;
  }
}
