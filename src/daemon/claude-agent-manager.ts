/**
 * Owns headless `ClaudeSession` instances for the `many agent` CLI command
 * group, keyed by agentId. Lives in the terminal daemon so sessions survive
 * between one-off CLI invocations. Mirrors ClaudeUiService but headless and
 * file-backed: every transcript event is appended to a per-agent NDJSON file
 * so `many agent tail` can replay history without a live daemon subscription.
 */

import fs from "node:fs";
import { ClaudeSession } from "@libclaude/core";
import type { ClaudeEvent, SessionStatus } from "@libclaude/core";
import type { ClaudeUiEvent } from "../shared/protocol.js";
import { mapClaudeEvent } from "../shared/claude-event-map.js";
import { getAgentLogDir, getAgentTranscriptPath } from "../cli/task-registry.js";
import logger from "../shared/logger.js";

export interface AgentInfo {
  agentId: string;
  worktreePath: string;
  sessionId: string | null;
  title?: string;
}

interface ManagedAgent {
  session: ClaudeSession;
  worktreePath: string;
  transcriptStream: fs.WriteStream;
  buffer: ClaudeUiEvent[];
  lastStatus?: ClaudeUiEvent;
  title?: string;
  sessionId: string | null;
  listeners: Set<(e: ClaudeUiEvent) => void>;
}

function truncateTitle(t: string): string {
  return t.length > 60 ? t.slice(0, 60) + "..." : t;
}

export class ClaudeAgentManager {
  private agents = new Map<string, ManagedAgent>();

  create(
    agentId: string,
    worktreePath: string,
    opts: { prompt?: string; claudeBin?: string }
  ): AgentInfo {
    const existing = this.agents.get(agentId);
    if (existing) return this.toInfo(agentId, existing);

    fs.mkdirSync(getAgentLogDir(), { recursive: true });
    const transcriptStream = fs.createWriteStream(getAgentTranscriptPath(agentId), { flags: "a" });
    // A transcript write failure must never crash the daemon: log and carry on.
    transcriptStream.on("error", (err) => {
      logger.error(`[agent ${agentId}] transcript write failed: ${err.message}`);
    });

    const session = new ClaudeSession({
      cwd: worktreePath,
      permissionMode: "auto",
      claudeBin: opts.claudeBin,
    });

    const managed: ManagedAgent = {
      session,
      worktreePath,
      transcriptStream,
      buffer: [],
      sessionId: null,
      listeners: new Set(),
    };
    this.agents.set(agentId, managed);

    session.on("event", (evt: ClaudeEvent) => {
      const ui = mapClaudeEvent(evt);
      if (ui) this.push(managed, ui);
    });
    session.on("status", (s: SessionStatus) => {
      managed.sessionId = s.sessionId;
      this.push(managed, {
        type: "status",
        ready: s.ready,
        busy: s.busy,
        queued: s.queued,
        sessionId: s.sessionId,
      });
    });
    session.on("error", (err: Error) => {
      logger.error(`[agent ${agentId}] session error: ${err.message}`);
      this.push(managed, { type: "error", message: err.message });
    });

    const prompt = opts.prompt?.trim();
    if (prompt) {
      managed.title = truncateTitle(prompt);
      this.push(managed, { type: "prompt", text: prompt });
      session.prompt(prompt).catch((err: Error) => {
        this.push(managed, { type: "error", message: err.message });
      });
    }

    return this.toInfo(agentId, managed);
  }

  send(agentId: string, message: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent ${agentId} not found`);
    if (!managed.title) managed.title = truncateTitle(message);
    this.push(managed, { type: "prompt", text: message });
    managed.session.prompt(message).catch((err: Error) => {
      this.push(managed, { type: "error", message: err.message });
    });
  }

  subscribe(agentId: string, listener: (e: ClaudeUiEvent) => void): () => void {
    const managed = this.agents.get(agentId);
    if (!managed) return () => {};
    for (const e of managed.buffer) listener(e);
    if (managed.lastStatus) listener(managed.lastStatus);
    managed.listeners.add(listener);
    return () => managed.listeners.delete(listener);
  }

  list(): AgentInfo[] {
    return [...this.agents.entries()].map(([agentId, managed]) => this.toInfo(agentId, managed));
  }

  get(agentId: string): AgentInfo | undefined {
    const managed = this.agents.get(agentId);
    return managed ? this.toInfo(agentId, managed) : undefined;
  }

  close(agentId: string): void {
    const managed = this.agents.get(agentId);
    if (!managed) return;
    managed.session.dispose();
    managed.transcriptStream.end();
    managed.listeners.clear();
    this.agents.delete(agentId);
  }

  cleanup(): void {
    for (const managed of this.agents.values()) {
      managed.session.dispose();
      managed.transcriptStream.end();
    }
    this.agents.clear();
  }

  private toInfo(agentId: string, managed: ManagedAgent): AgentInfo {
    return {
      agentId,
      worktreePath: managed.worktreePath,
      sessionId: managed.sessionId,
      title: managed.title,
    };
  }

  private push(managed: ManagedAgent, event: ClaudeUiEvent): void {
    if (event.type === "status") {
      managed.lastStatus = event;
    } else if (event.type !== "init") {
      managed.buffer.push(event);
      if (managed.buffer.length > 2000) managed.buffer.shift();
      managed.transcriptStream.write(JSON.stringify(event) + "\n");
    }
    for (const listener of managed.listeners) listener(event);
  }
}
