import crypto from "node:crypto";
import type { ClaudeUiEvent, ClaudeUiPermissionMode } from "../../shared/protocol.js";
import type { TerminalManagerClient } from "../../daemon/terminal-client.js";
import { getSessionUiEvents } from "../claude-sessions.js";

function truncateTitle(text: string): string {
  return text.length > 60 ? text.slice(0, 60) + "..." : text;
}

/**
 * Thin async RPC client over the terminal daemon's `ClaudeUiManager`, which
 * actually owns the live `ClaudeSession`s. Sessions live in the detached
 * daemon (see src/daemon/claude-ui-manager.ts), so they survive the web
 * server / Electron app closing, the same way terminal PTYs do.
 */
export class ClaudeUiService {
  constructor(private client: TerminalManagerClient) {}

  async create(worktreePath: string, claudeBin?: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    await this.client.claudeUiCreate(sessionId, worktreePath, claudeBin);
    return sessionId;
  }

  /**
   * Resume an existing on-disk Claude session in the Claude UI: seed the buffer
   * with its transcript so the panel renders prior turns, then have the daemon
   * spawn a CLI resuming that conversation. Keyed by the on-disk session id so
   * a returning client re-attaches to it. If the session is already live, this
   * is a no-op.
   */
  async resume(worktreePath: string, sessionId: string, claudeBin?: string): Promise<string> {
    const seed = await getSessionUiEvents(sessionId, worktreePath);
    const firstPrompt = seed.find((e) => e.type === "prompt") as { type: "prompt"; text: string } | undefined;
    await this.client.claudeUiResume(sessionId, worktreePath, seed, {
      title: firstPrompt ? truncateTitle(firstPrompt.text) : undefined,
      firstPrompt: firstPrompt?.text,
      claudeBin,
    });
    return sessionId;
  }

  async list(worktreePath: string): Promise<{ sessionId: string; title?: string; needsAttention?: boolean }[]> {
    const sessions = await this.client.claudeUiList(worktreePath);
    return sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, needsAttention: s.needsAttention }));
  }

  async listAll(): Promise<{ sessionId: string; worktreePath: string; title?: string; needsAttention?: boolean }[]> {
    const sessions = await this.client.claudeUiListAll();
    return sessions.map((s) => ({ sessionId: s.sessionId, worktreePath: s.worktreePath, title: s.title, needsAttention: s.needsAttention }));
  }

  async send(sessionId: string, prompt: string): Promise<void> {
    await this.client.claudeUiSend(sessionId, prompt);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.claudeUiInterrupt(sessionId);
  }

  async setPermissionMode(sessionId: string, mode: ClaudeUiPermissionMode): Promise<void> {
    await this.client.claudeUiSetPermissionMode(sessionId, mode);
  }

  async reset(sessionId: string): Promise<void> {
    await this.client.claudeUiReset(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    await this.client.claudeUiClose(sessionId);
  }

  /** Number of live Claude UI sessions across all worktrees (for shutdown prompts). */
  async getRunningCount(): Promise<number> {
    return (await this.client.claudeUiListAll()).length;
  }

  /** Count of live Claude UI sessions per worktree path (for activity indicators). */
  async getRunningCountsByWorktree(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const s of await this.client.claudeUiListAll()) {
      counts[s.worktreePath] = (counts[s.worktreePath] || 0) + 1;
    }
    return counts;
  }

  async subscribe(sessionId: string, listener: (e: ClaudeUiEvent) => void): Promise<() => void> {
    return this.client.claudeUiSubscribe(sessionId, listener);
  }
}
