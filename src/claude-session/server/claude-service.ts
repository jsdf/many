/**
 * Claude service: wraps @anthropic-ai/claude-agent-sdk v2 session API to manage
 * persistent multi-turn sessions with MCP servers that stay alive across turns.
 */

import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKSystemMessage,
  SDKStatusMessage,
  SDKToolProgressMessage,
  SDKSession,
  SDKSessionOptions,
  PermissionMode,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  SessionEvent,
  SessionMessage,
  ContentBlock,
  SessionStatus,
  PermissionRequest,
} from "../shared/protocol.js";
import logger from "../../shared/logger.js";
import { createRequire } from "module";

function getClaudeCodeExecutablePath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const sdkCliPath = require.resolve(
      "@anthropic-ai/claude-agent-sdk/cli.js"
    );
    if (sdkCliPath.includes("app.asar/")) {
      return sdkCliPath.replace("app.asar/", "app.asar.unpacked/");
    }
  } catch {
    // Not in asar or resolve failed - let SDK use its default
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveSession {
  sessionId: string;
  cwd: string;
  sdkSession: SDKSession;
  status: SessionStatus;
  /** Pending permission requests keyed by toolUseID */
  pendingPermissions: Map<string, PendingPermission>;
  listeners: Set<(event: SessionEvent) => void>;
  /** Buffer events emitted before any listener subscribes */
  eventBuffer: SessionEvent[];
  /** Promise that resolves when the stream consumer finishes */
  streamDone: Promise<void>;
  /** Callback to resolve session ID from stream (new sessions only) */
  _resolveSessionId?: (id: string) => void;
  _rejectSessionId?: (err: Error) => void;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ClaudeService {
  private sessions = new Map<string, ActiveSession>();

  /** Start a new session or resume an existing one */
  async start(opts: {
    cwd: string;
    prompt?: string;
    sessionId?: string;
    permissionMode?: PermissionMode;
  }): Promise<string> {
    const {
      unstable_v2_createSession,
      unstable_v2_resumeSession,
    } = await import("@anthropic-ai/claude-agent-sdk");

    // If we already have this session alive, just send the message
    if (opts.sessionId && this.sessions.has(opts.sessionId)) {
      if (opts.prompt) {
        await this.send(opts.sessionId, opts.prompt);
      }
      return opts.sessionId;
    }

    const isBypass = opts.permissionMode === "bypassPermissions";

    const sessionOpts: SDKSessionOptions = {
      model: "claude-sonnet-4-6",
      pathToClaudeCodeExecutable: getClaudeCodeExecutablePath(),
      permissionMode: opts.permissionMode ?? "default",
      // The SDK locates conversations under ~/.claude/projects/<sanitized-cwd>/,
      // keyed by `cwd` (defaults to process.cwd()). Without this, resume looks in
      // the server's project dir, not the worktree's, and fails to find the session.
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: {
        ...process.env,
        ...(opts.cwd ? { CLAUDE_CODE_CWD: opts.cwd } : {}),
      },
      ...(!isBypass
        ? {
            canUseTool: async (toolName, input, toolOpts) => {
              const session = [...this.sessions.values()].find(
                (s) => s.sdkSession === sdkSession
              );
              if (!session) return { behavior: "allow" as const };
              return this.handlePermissionRequest(
                session,
                toolName,
                input,
                toolOpts
              );
            },
          }
        : {}),
    };

    if (isBypass) {
      sessionOpts.allowedTools = ["*"];
    }

    let sdkSession: SDKSession;
    if (opts.sessionId) {
      sdkSession = unstable_v2_resumeSession(opts.sessionId, sessionOpts);
    } else {
      sdkSession = unstable_v2_createSession(sessionOpts);
    }

    const session: ActiveSession = {
      sessionId: opts.sessionId ?? "", // filled from stream for new sessions
      cwd: opts.cwd,
      sdkSession,
      status: "running",
      pendingPermissions: new Map(),
      listeners: new Set(),
      eventBuffer: [],
      streamDone: Promise.resolve(),
    };

    // Start consuming the stream. For new sessions, we need the session ID
    // from the first message before we can return.
    const sessionIdPromise = opts.sessionId
      ? Promise.resolve(opts.sessionId)
      : new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for session ID from SDK"));
          }, 30_000);
          session._resolveSessionId = (id: string) => {
            clearTimeout(timeout);
            session._rejectSessionId = undefined;
            resolve(id);
          };
          session._rejectSessionId = (err: Error) => {
            clearTimeout(timeout);
            session._resolveSessionId = undefined;
            reject(err);
          };
        });

    const streamDone = this.consumeStream(session);
    session.streamDone = streamDone;

    // Send the initial prompt
    await sdkSession.send(opts.prompt || "hello");

    // Wait for the session ID
    const sessionId = await sessionIdPromise;
    session.sessionId = sessionId;
    this.sessions.set(sessionId, session);

    logger.info(`[claude-service] Session started: ${sessionId}`);
    return sessionId;
  }

  /** Send a follow-up message to a running session */
  async send(sessionId: string, message: string): Promise<void> {
    const session = this.getSession(sessionId);
    session.status = "running";
    this.emit(session, { type: "status", status: "running" });
    await session.sdkSession.send(message);
  }

  /** Respond to a permission request */
  resolvePermission(
    sessionId: string,
    requestId: string,
    allow: boolean
  ): void {
    const session = this.getSession(sessionId);
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`No pending permission: ${requestId}`);

    const result: PermissionResult = allow
      ? { behavior: "allow" }
      : { behavior: "deny", message: "User denied" };

    pending.resolve(result);
    session.pendingPermissions.delete(requestId);

    this.emit(session, { type: "permission_resolved", requestId });

    session.status = "running";
    this.emit(session, { type: "status", status: "running" });
  }

  /** Interrupt a running session */
  async interrupt(sessionId: string): Promise<void> {
    // The v2 API doesn't expose interrupt directly on SDKSession.
    // We'll close and let the user resume later.
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sdkSession.close();
  }

  /** Close and clean up a session */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sdkSession.close();
    session.listeners.clear();
    session.pendingPermissions.clear();
    this.sessions.delete(sessionId);
  }

  /** Subscribe to session events. Flushes any buffered events immediately. */
  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};

    session.listeners.add(listener);

    // Flush buffered events to this new listener
    if (session.eventBuffer.length > 0) {
      for (const event of session.eventBuffer) {
        try {
          listener(event);
        } catch {
          // ignore
        }
      }
      session.eventBuffer = [];
    }

    return () => {
      session.listeners.delete(listener);
    };
  }

  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getStatus(sessionId: string): SessionStatus {
    return this.sessions.get(sessionId)?.status ?? "idle";
  }

  getActiveSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Get count of active sessions per working directory */
  getSessionCountsByCwd(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const session of this.sessions.values()) {
      counts[session.cwd] = (counts[session.cwd] || 0) + 1;
    }
    return counts;
  }

  /** Shut down all sessions */
  destroy(): void {
    for (const session of this.sessions.values()) {
      session.sdkSession.close();
      session.listeners.clear();
    }
    this.sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private getSession(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No active session: ${sessionId}`);
    return session;
  }

  /**
   * Consume the SDK message stream. Re-calls stream() after each turn
   * to keep the session alive for multi-turn conversations.
   * The session stays in the map until explicitly closed or an error occurs.
   */
  private async consumeStream(session: ActiveSession): Promise<void> {
    try {
      // The v2 stream() may complete after each turn, so we loop
      // and re-call stream() to listen for the next turn's messages
      // (triggered by send()).
      while (true) {
        let gotMessages = false;
        for await (const msg of session.sdkSession.stream()) {
          gotMessages = true;
          // Capture session_id from the first message if we don't have it yet
          if (session._resolveSessionId && "session_id" in msg) {
            session._resolveSessionId((msg as any).session_id);
            session._resolveSessionId = undefined;
          }

          this.processMessage(session, msg);
        }

        // If the stream ended without producing any messages, the session
        // is truly done (closed externally or SDK shut down)
        if (!gotMessages) {
          logger.info(`[claude-service] Session stream closed: ${session.sessionId}`);
          break;
        }

        // Stream ended after a turn — session stays alive, wait for next send()
        logger.debug(`[claude-service] Turn complete, awaiting next message: ${session.sessionId}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[claude-service] Stream error: ${errMsg}`);
      session.status = "error";
      this.emit(session, { type: "error", error: errMsg });

      // If session ID was never resolved, reject the promise so the
      // caller doesn't hang for the full 30s timeout.
      if (session._resolveSessionId) {
        // _resolveSessionId is actually a resolve callback, but we need
        // to reject. We stored the reject separately below.
        session._rejectSessionId?.(
          new Error(`Session failed to start: ${errMsg}`)
        );
        session._resolveSessionId = undefined;
        session._rejectSessionId = undefined;
      }
    } finally {
      logger.info(`[claude-service] Session ended: ${session.sessionId}`);
      session.status = "idle";
      this.emit(session, { type: "status", status: "idle" });
      this.sessions.delete(session.sessionId);
    }
  }

  private async handlePermissionRequest(
    session: ActiveSession,
    toolName: string,
    input: Record<string, unknown>,
    toolOpts: {
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
    }
  ): Promise<PermissionResult> {
    session.status = "waiting_permission";
    this.emit(session, { type: "status", status: "waiting_permission" });

    const request: PermissionRequest = {
      requestId: toolOpts.toolUseID,
      toolName,
      toolInput: input,
      description: toolOpts.description,
      displayName: toolOpts.displayName,
    };

    this.emit(session, { type: "permission_request", request });

    return new Promise<PermissionResult>((resolve) => {
      session.pendingPermissions.set(toolOpts.toolUseID, {
        request,
        resolve,
      });
    });
  }

  private processMessage(session: ActiveSession, msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant":
        this.handleAssistant(session, msg);
        break;

      case "user":
        this.handleUser(session, msg as SDKUserMessage | SDKUserMessageReplay);
        break;

      case "result":
        this.handleResult(session, msg);
        break;

      case "system":
        this.handleSystem(session, msg as any);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg as SDKToolProgressMessage);
        break;

      default:
        break;
    }
  }

  private handleAssistant(
    session: ActiveSession,
    msg: SDKAssistantMessage
  ): void {
    const content: ContentBlock[] = [];

    for (const block of msg.message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        content.push({
          type: "thinking",
          thinking: (block as any).thinking ?? "",
        });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          toolUse: {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          },
        });
      }
    }

    const sessionMsg: SessionMessage = {
      id: msg.uuid,
      role: "assistant",
      content,
      timestamp: Date.now(),
      error: msg.error ?? undefined,
    };

    session.status = "running";
    this.emit(session, { type: "message", message: sessionMsg });
  }

  private handleUser(
    session: ActiveSession,
    msg: SDKUserMessage | SDKUserMessageReplay
  ): void {
    const content: ContentBlock[] = [];
    const rawContent = msg.message.content;

    if (typeof rawContent === "string") {
      content.push({ type: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const block of rawContent) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_result") {
          const output =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
          content.push({
            type: "tool_result",
            toolResult: {
              toolUseId: block.tool_use_id,
              output,
              isError: block.is_error ?? false,
            },
          });
        }
      }
    }

    const sessionMsg: SessionMessage = {
      id: (msg as any).uuid ?? crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    this.emit(session, { type: "message", message: sessionMsg });
  }

  private handleResult(session: ActiveSession, msg: SDKResultMessage): void {
    // With v2 sessions, the session stays alive after a result.
    // Status goes to idle but the session is NOT deleted.
    session.status = "idle";

    this.emit(session, {
      type: "result",
      result: {
        isError: msg.is_error,
        durationMs: msg.duration_ms,
        totalCostUsd: msg.total_cost_usd,
        numTurns: msg.num_turns,
      },
    });

    // Also emit a status change so the frontend updates its status badge.
    this.emit(session, { type: "status", status: "idle" });
  }

  private handleSystem(
    session: ActiveSession,
    msg: SDKSystemMessage | SDKStatusMessage
  ): void {
    if ("subtype" in msg && msg.subtype === "status") {
      const statusMsg = msg as SDKStatusMessage;
      if (statusMsg.status === "compacting") {
        session.status = "compacting";
        this.emit(session, { type: "status", status: "compacting" });
      }
    }
  }

  private handleToolProgress(
    session: ActiveSession,
    msg: SDKToolProgressMessage
  ): void {
    this.emit(session, {
      type: "tool_progress",
      toolUseId: msg.tool_use_id,
      toolName: msg.tool_name,
      elapsed: msg.elapsed_time_seconds,
    });
  }

  private emit(session: ActiveSession, event: SessionEvent): void {
    // If no listeners yet, buffer events so they can be flushed
    // when the client subscribes (avoids race between start() returning
    // and the client setting up the subscription).
    if (session.listeners.size === 0) {
      session.eventBuffer.push(event);
      return;
    }

    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let a failing listener break the stream
      }
    }
  }
}
