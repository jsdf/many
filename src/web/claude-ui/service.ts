import crypto from "node:crypto";
import { ClaudeSession } from "@libclaude/core";
import type { ClaudeEvent, SessionStatus } from "@libclaude/core";
import type { ClaudeUiEvent, ClaudeUiContentBlock, ClaudeUiPermissionMode } from "../../shared/protocol.js";

interface ManagedSession {
  session: ClaudeSession;
  worktreePath: string;
  buffer: ClaudeUiEvent[];
  listeners: Set<(e: ClaudeUiEvent) => void>;
}

export class ClaudeUiService {
  private sessions = new Map<string, ManagedSession>();

  create(worktreePath: string, claudeBin?: string): string {
    const sessionId = crypto.randomUUID();
    // Run through an interactive login shell so a configured claudeBin that is
    // a shell alias or a command with args (e.g. "claude --mcp-config ...")
    // resolves the way it would in the user's terminal. Default to "auto"
    // permission mode; callers can change it at runtime via setPermissionMode.
    const session = new ClaudeSession({ cwd: worktreePath, permissionMode: "auto", claudeBin, loginShell: true });

    const managed: ManagedSession = {
      session,
      worktreePath,
      buffer: [],
      listeners: new Set(),
    };

    session.on("event", (evt: ClaudeEvent) => {
      const uiEvent = mapClaudeEvent(evt);
      if (uiEvent) this.push(managed, uiEvent);
    });

    session.on("status", (status: SessionStatus) => {
      this.push(managed, {
        type: "status",
        ready: status.ready,
        busy: status.busy,
        queued: status.queued,
        sessionId: status.sessionId,
      });
    });

    session.on("error", (err: Error) => {
      this.push(managed, { type: "error", message: err.message });
    });

    this.sessions.set(sessionId, managed);
    return sessionId;
  }

  send(sessionId: string, prompt: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Claude UI session ${sessionId} not found`);
    managed.session.prompt(prompt).catch((err: Error) => {
      this.push(managed, { type: "error", message: err.message });
    });
  }

  interrupt(sessionId: string): void {
    this.sessions.get(sessionId)?.session.interrupt();
  }

  setPermissionMode(sessionId: string, mode: ClaudeUiPermissionMode): void {
    this.sessions.get(sessionId)?.session.setPermissionMode(mode);
  }

  reset(sessionId: string): void {
    this.sessions.get(sessionId)?.session.reset();
  }

  close(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed.session.dispose();
    managed.listeners.clear();
    this.sessions.delete(sessionId);
  }

  subscribe(sessionId: string, listener: (e: ClaudeUiEvent) => void): () => void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return () => {};
    for (const e of managed.buffer) listener(e);
    managed.listeners.add(listener);
    return () => managed.listeners.delete(listener);
  }

  destroy(): void {
    for (const managed of this.sessions.values()) {
      managed.session.dispose();
    }
    this.sessions.clear();
  }

  private push(managed: ManagedSession, event: ClaudeUiEvent): void {
    managed.buffer.push(event);
    if (managed.buffer.length > 2000) managed.buffer.shift();
    for (const listener of managed.listeners) listener(event);
  }
}

function mapContentBlock(block: { type: string; [k: string]: unknown }): ClaudeUiContentBlock | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      input: block.input,
    };
  }
  if (block.type === "tool_result") {
    const content = block.content;
    const text = Array.isArray(content)
      ? content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("")
      : typeof content === "string"
        ? content
        : JSON.stringify(content);
    return {
      type: "tool_result",
      toolUseId: String(block.tool_use_id ?? ""),
      content: text,
      isError: block.is_error === true,
    };
  }
  return null;
}

function mapClaudeEvent(evt: ClaudeEvent): ClaudeUiEvent | null {
  if (evt.type === "system" && (evt as any).subtype === "init") {
    return { type: "init", sessionId: String((evt as any).session_id ?? "") };
  }
  if (evt.type === "assistant") {
    const content = (evt as any).message?.content;
    if (!Array.isArray(content)) return null;
    const blocks = content.map(mapContentBlock).filter((b): b is ClaudeUiContentBlock => b !== null);
    return { type: "assistant", content: blocks };
  }
  if (evt.type === "user") {
    const content = (evt as any).message?.content;
    if (!Array.isArray(content)) return null;
    const blocks = content.map(mapContentBlock).filter((b): b is ClaudeUiContentBlock => b !== null);
    if (blocks.length === 0) return null;
    return { type: "user", content: blocks };
  }
  if (evt.type === "result") {
    const r = evt as any;
    return {
      type: "result",
      isError: r.is_error === true,
      costUsd: r.total_cost_usd,
      durationMs: r.duration_ms,
    };
  }
  return null;
}
