/**
 * Terminal daemon entry point.
 *
 * Owns the real `TerminalManager` and all PTYs over a Unix socket / named pipe.
 * It never kills PTYs on client disconnect — only on explicit `close`,
 * `cleanupWorktree`, or `shutdown`. The web server / Electron app connect as
 * clients (see terminal-client.ts) and may come and go without affecting PTYs.
 */

import net from "net";
import { promises as fs } from "fs";
import logger from "../shared/logger.js";
import { TerminalManager, type TerminalSessionInfo } from "../web/terminal-manager.js";
import {
  DAEMON_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  type DaemonRequest,
  type SavedSessionLog,
} from "./terminal-daemon-protocol.js";
import {
  getSocketPath,
  writeDaemonInfo,
  removeDaemonInfo,
  logDaemon,
} from "./daemon-lifecycle.js";
import { saveAndRegisterTerminalLog } from "./log-capture.js";
import { ClaudeAgentManager, type AgentInfo } from "./claude-agent-manager.js";
import { ClaudeUiManager } from "./claude-ui-manager.js";
import type { ClaudeUiEvent, ClaudeUiPermissionMode, ClaudeUiModel, ClaudeUiEffort } from "../shared/protocol.js";
import type { ClaudeUiInfoWire } from "./terminal-daemon-protocol.js";

/**
 * The subset of ClaudeAgentManager the IPC layer depends on. Declared as an
 * interface so tests can supply a fake agent manager that does not spawn a real
 * claude process (ClaudeAgentManager satisfies it structurally).
 */
export interface AgentManager {
  create(
    agentId: string,
    worktreePath: string,
    opts: { prompt?: string; claudeBin?: string }
  ): AgentInfo;
  send(agentId: string, message: string): void;
  subscribe(agentId: string, listener: (e: ClaudeUiEvent) => void): () => void;
  list(): AgentInfo[];
  cleanup(): void;
}

/**
 * The subset of ClaudeUiManager the IPC layer depends on. Declared as an
 * interface so tests can supply a fake UI manager that does not spawn a real
 * claude process (ClaudeUiManager satisfies it structurally).
 */
export interface ClaudeUiManagerIface {
  create(sessionId: string, worktreePath: string, claudeBin?: string): ClaudeUiInfoWire;
  resume(
    sessionId: string,
    worktreePath: string,
    seed: ClaudeUiEvent[],
    opts: { title?: string; firstPrompt?: string; claudeBin?: string },
  ): ClaudeUiInfoWire;
  send(sessionId: string, prompt: string): void;
  subscribe(sessionId: string, listener: (e: ClaudeUiEvent) => void): () => void;
  list(worktreePath: string): ClaudeUiInfoWire[];
  listAll(): ClaudeUiInfoWire[];
  interrupt(sessionId: string): void;
  setPermissionMode(sessionId: string, mode: ClaudeUiPermissionMode): void;
  setModelAndEffort(sessionId: string, model: ClaudeUiModel, effort: ClaudeUiEffort): void;
  reset(sessionId: string): void;
  close(sessionId: string): void;
  cleanup(): void;
}

/**
 * The subset of TerminalManager the IPC layer depends on. Declared as an
 * interface so tests can supply a fake manager (TerminalManager satisfies it
 * structurally via its public methods).
 */
export interface DaemonManager {
  createSession(
    terminalId: string,
    worktreePath: string,
    cols: number,
    rows: number,
    extraEnv?: Record<string, string>,
    initialCommand?: string,
    terminalLogDir?: string | null,
    taskId?: string,
    claudeSessionId?: string
  ): boolean;
  sendData(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  closeSession(terminalId: string): void;
  getSessionPid(terminalId: string): number | null;
  getSessionsForWorktree(worktreePath: string): string[];
  listAllSessions(): TerminalSessionInfo[];
  getSessionCountsByWorktree(): Record<string, number>;
  setLabel(terminalId: string, label: string): void;
  cleanupWorktree(worktreePath: string): void;
  getBufferedOutput(terminalId: string): string;
  saveAllSessionLogs(logDir: string): Promise<SavedSessionLog[]>;
  addDataListener(terminalId: string, listener: (data: string) => void): void;
  removeDataListener(terminalId: string, listener: (data: string) => void): void;
  addExitListener(terminalId: string, listener: () => void): void;
  removeExitListener(terminalId: string, listener: () => void): void;
  addBellListener(terminalId: string, listener: () => void): void;
  removeBellListener(terminalId: string, listener: () => void): void;
  cleanup(): void;
}

/**
 * Wire one client connection to the manager. Returns a disconnect cleanup that
 * removes this connection's listeners WITHOUT killing PTYs.
 */
export function attachConnection(
  manager: DaemonManager,
  agentManager: AgentManager,
  uiManager: ClaudeUiManagerIface,
  socket: net.Socket,
  onShutdown: () => void,
  onSessionCreated?: (terminalId: string, worktreePath: string) => void
): () => void {
  const decoder = new FrameDecoder();
  // Each subscription (terminal or agent) is represented by its own dispose
  // function, so subscribe/unsubscribe don't need to know which kind it is.
  const subs = new Map<number, () => void>();

  const send = (msg: unknown) => {
    if (!socket.destroyed) socket.write(encodeFrame(msg));
  };
  const respond = (reqId: number, result: unknown) =>
    send({ type: "response", reqId, result });
  const respondError = (reqId: number, error: string) =>
    send({ type: "response", reqId, error });
  const sendEvent = (subId: number, event: unknown) =>
    send({ type: "event", subId, event });

  const removeSub = (subId: number) => {
    const dispose = subs.get(subId);
    if (!dispose) return;
    dispose();
    subs.delete(subId);
  };

  const cleanup = () => {
    for (const subId of subs.keys()) removeSub(subId);
  };

  const handle = async (req: DaemonRequest): Promise<void> => {
    switch (req.op) {
      case "createSession": {
        const existed = manager.createSession(
          req.terminalId,
          req.worktreePath,
          req.cols,
          req.rows,
          req.extraEnv,
          req.initialCommand,
          req.logDir,
          req.taskId,
          req.claudeSessionId
        );
        const pid = manager.getSessionPid(req.terminalId);
        // Register the log-capture exit hook once, only for genuinely new
        // sessions (reconnects return existed=true).
        if (!existed) onSessionCreated?.(req.terminalId, req.worktreePath);
        respond(req.reqId, { existed, pid });
        break;
      }
      case "input":
        manager.sendData(req.terminalId, req.data);
        respond(req.reqId, { ok: true });
        break;
      case "resize":
        manager.resize(req.terminalId, req.cols, req.rows);
        respond(req.reqId, { ok: true });
        break;
      case "close":
        manager.closeSession(req.terminalId);
        respond(req.reqId, { ok: true });
        break;
      case "getSessionPid":
        respond(req.reqId, { pid: manager.getSessionPid(req.terminalId) });
        break;
      case "listSessions":
        respond(req.reqId, { ids: manager.getSessionsForWorktree(req.worktreePath) });
        break;
      case "listAll":
        respond(req.reqId, { sessions: manager.listAllSessions() });
        break;
      case "counts":
        respond(req.reqId, { counts: manager.getSessionCountsByWorktree() });
        break;
      case "setLabel":
        manager.setLabel(req.terminalId, req.label);
        respond(req.reqId, { ok: true });
        break;
      case "cleanupWorktree":
        manager.cleanupWorktree(req.worktreePath);
        respond(req.reqId, { ok: true });
        break;
      case "getBufferedOutput":
        respond(req.reqId, { output: manager.getBufferedOutput(req.terminalId) });
        break;
      case "saveAllSessionLogs": {
        const saved = await manager.saveAllSessionLogs(req.logDir);
        respond(req.reqId, { saved });
        break;
      }
      case "ping":
        respond(req.reqId, { ok: true, version: DAEMON_PROTOCOL_VERSION });
        break;
      case "shutdown":
        respond(req.reqId, { ok: true });
        onShutdown();
        break;
      case "subscribe": {
        // Atomic buffered-then-live: capture the buffer and register the live
        // listener synchronously so no PTY data can interleave between them.
        const { terminalId, subId } = req;
        const buffered = manager.getBufferedOutput(terminalId);
        if (buffered) sendEvent(subId, { type: "buffered", data: buffered });
        const dataListener = (data: string) => sendEvent(subId, { type: "data", data });
        const exitListener = () => sendEvent(subId, { type: "exit" });
        const bellListener = () => sendEvent(subId, { type: "bell" });
        manager.addDataListener(terminalId, dataListener);
        manager.addExitListener(terminalId, exitListener);
        manager.addBellListener(terminalId, bellListener);
        subs.set(subId, () => {
          manager.removeDataListener(terminalId, dataListener);
          manager.removeExitListener(terminalId, exitListener);
          manager.removeBellListener(terminalId, bellListener);
        });
        respond(req.reqId, { ok: true });
        break;
      }
      case "subscribeExit": {
        // Exit-only watch (used for task completion); no buffered/data replay.
        const { terminalId, subId } = req;
        const exitListener = () => sendEvent(subId, { type: "exit" });
        manager.addExitListener(terminalId, exitListener);
        subs.set(subId, () => manager.removeExitListener(terminalId, exitListener));
        respond(req.reqId, { ok: true });
        break;
      }
      case "agentCreate": {
        const agent = agentManager.create(req.agentId, req.worktreePath, {
          prompt: req.prompt,
          claudeBin: req.claudeBin,
        });
        respond(req.reqId, { agent });
        break;
      }
      case "agentSend":
        agentManager.send(req.agentId, req.message);
        respond(req.reqId, { ok: true });
        break;
      case "agentList":
        respond(req.reqId, { agents: agentManager.list() });
        break;
      case "agentSubscribe": {
        // agentManager.subscribe replays its buffer synchronously into the
        // listener, which sendEvent forwards immediately: the same atomic
        // buffered-then-live guarantee as the terminal "subscribe" case above.
        const { agentId, subId } = req;
        const unsub = agentManager.subscribe(agentId, (event) =>
          sendEvent(subId, { type: "agent", event })
        );
        subs.set(subId, unsub);
        respond(req.reqId, { ok: true });
        break;
      }
      case "claudeUiCreate": {
        const session = uiManager.create(req.sessionId, req.worktreePath, req.claudeBin);
        respond(req.reqId, { session });
        break;
      }
      case "claudeUiResume": {
        const session = uiManager.resume(req.sessionId, req.worktreePath, req.seed, {
          title: req.title,
          firstPrompt: req.firstPrompt,
          claudeBin: req.claudeBin,
        });
        respond(req.reqId, { session });
        break;
      }
      case "claudeUiSend":
        uiManager.send(req.sessionId, req.prompt);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiList":
        respond(req.reqId, { sessions: uiManager.list(req.worktreePath) });
        break;
      case "claudeUiListAll":
        respond(req.reqId, { sessions: uiManager.listAll() });
        break;
      case "claudeUiSetPermissionMode":
        uiManager.setPermissionMode(req.sessionId, req.mode);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiSetModelEffort":
        uiManager.setModelAndEffort(req.sessionId, req.model, req.effort);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiInterrupt":
        uiManager.interrupt(req.sessionId);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiReset":
        uiManager.reset(req.sessionId);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiClose":
        uiManager.close(req.sessionId);
        respond(req.reqId, { ok: true });
        break;
      case "claudeUiSubscribe": {
        // uiManager.subscribe replays its buffer synchronously into the
        // listener, which sendEvent forwards immediately: the same atomic
        // buffered-then-live guarantee as the terminal "subscribe" case above.
        const { sessionId, subId } = req;
        const unsub = uiManager.subscribe(sessionId, (event) =>
          sendEvent(subId, { type: "claudeUi", event })
        );
        subs.set(subId, unsub);
        respond(req.reqId, { ok: true });
        break;
      }
      case "unsubscribe":
        removeSub(req.subId);
        respond(req.reqId, { ok: true });
        break;
    }
  };

  socket.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (err) {
      logger.error("[terminal-daemon] failed to decode frame:", err);
      return;
    }
    for (const msg of messages) {
      handle(msg as DaemonRequest).catch((err) => {
        const reqId = (msg as DaemonRequest)?.reqId;
        logger.error("[terminal-daemon] request failed:", err);
        if (typeof reqId === "number") {
          respondError(reqId, err instanceof Error ? err.message : String(err));
        }
      });
    }
  });

  socket.on("error", () => {
    /* client gone; cleanup runs on close */
  });
  socket.on("close", cleanup);

  return cleanup;
}

/** Create the daemon's IPC server bound to the manager. */
export function createDaemonServer(
  manager: DaemonManager,
  onShutdown: () => void,
  onSessionCreated?: (terminalId: string, worktreePath: string) => void,
  agentManager: AgentManager = new ClaudeAgentManager(),
  uiManager: ClaudeUiManagerIface = new ClaudeUiManager()
): net.Server {
  const server = net.createServer((socket) => {
    attachConnection(manager, agentManager, uiManager, socket, onShutdown, onSessionCreated);
  });
  return server;
}

async function main(): Promise<void> {
  const manager = new TerminalManager();
  const agentManager = new ClaudeAgentManager();
  const uiManager = new ClaudeUiManager();
  const socketPath = getSocketPath();

  // Clear any stale Unix socket file from a previous (dead) daemon.
  if (process.platform !== "win32") {
    try {
      await fs.unlink(socketPath);
    } catch {
      // not present
    }
  }

  let shuttingDown = false;

  // Per-PTY natural exit: save the buffered output to a log + register a task.
  // Suppressed during shutdown, which captures all running sessions explicitly
  // (below) so the kill-triggered exits don't double-save.
  const onSessionCreated = (terminalId: string, worktreePath: string) => {
    manager.addExitListener(terminalId, () => {
      if (shuttingDown) return;
      const output = manager.getBufferedOutput(terminalId);
      const claudeSessionId = manager
        .listAllSessions()
        .find((s) => s.terminalId === terminalId)?.claudeSessionId;
      saveAndRegisterTerminalLog(terminalId, worktreePath, output, claudeSessionId).catch(() => {});
    });
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logDaemon(`shutting down (${signal})`);
    // PTYs are actually being killed here, so capture their logs first.
    const sessions = manager.listAllSessions();
    await Promise.all(
      sessions.map((s) =>
        saveAndRegisterTerminalLog(
          s.terminalId,
          s.worktreePath,
          manager.getBufferedOutput(s.terminalId),
          s.claudeSessionId,
          true
        )
      )
    );
    agentManager.cleanup();
    uiManager.cleanup();
    manager.cleanup();
    server.close();
    await removeDaemonInfo();
    process.exit(0);
  };

  const server = createDaemonServer(
    manager,
    () => {
      shutdown("shutdown-request").catch((err) => {
        logger.error("[terminal-daemon] shutdown failed:", err);
        process.exit(1);
      });
    },
    onSessionCreated,
    agentManager,
    uiManager
  );

  server.on("error", (err) => {
    logger.error("[terminal-daemon] server error:", err);
    process.exit(1);
  });

  server.listen(socketPath, async () => {
    await writeDaemonInfo({
      pid: process.pid,
      socketPath,
      version: DAEMON_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
    });
    logDaemon(`listening on ${socketPath} (pid ${process.pid})`);
  });

  const onSignal = (signal: string) =>
    shutdown(signal).catch((err) => {
      logger.error("[terminal-daemon] shutdown failed:", err);
      process.exit(1);
    });
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

// Run only when invoked directly as the daemon entry (not when imported in tests).
const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((err) => {
    logger.error("[terminal-daemon] fatal:", err);
    process.exit(1);
  });
}
