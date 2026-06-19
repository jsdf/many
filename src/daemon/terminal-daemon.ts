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
    terminalLogDir?: string | null
  ): boolean;
  sendData(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  closeSession(terminalId: string): void;
  getSessionPid(terminalId: string): number | null;
  getSessionsForWorktree(worktreePath: string): string[];
  listAllSessions(): TerminalSessionInfo[];
  getSessionCountsByWorktree(): Record<string, number>;
  cleanupWorktree(worktreePath: string): void;
  getBufferedOutput(terminalId: string): string;
  saveAllSessionLogs(logDir: string): Promise<SavedSessionLog[]>;
  addDataListener(terminalId: string, listener: (data: string) => void): void;
  removeDataListener(terminalId: string, listener: (data: string) => void): void;
  addExitListener(terminalId: string, listener: () => void): void;
  removeExitListener(terminalId: string, listener: () => void): void;
  cleanup(): void;
}

interface ActiveSubscription {
  terminalId: string;
  dataListener?: (data: string) => void;
  exitListener: () => void;
}

/**
 * Wire one client connection to the manager. Returns a disconnect cleanup that
 * removes this connection's listeners WITHOUT killing PTYs.
 */
export function attachConnection(
  manager: DaemonManager,
  socket: net.Socket,
  onShutdown: () => void
): () => void {
  const decoder = new FrameDecoder();
  const subs = new Map<number, ActiveSubscription>();

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
    const sub = subs.get(subId);
    if (!sub) return;
    if (sub.dataListener) manager.removeDataListener(sub.terminalId, sub.dataListener);
    manager.removeExitListener(sub.terminalId, sub.exitListener);
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
          req.logDir
        );
        const pid = manager.getSessionPid(req.terminalId);
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
        manager.addDataListener(terminalId, dataListener);
        manager.addExitListener(terminalId, exitListener);
        subs.set(subId, { terminalId, dataListener, exitListener });
        respond(req.reqId, { ok: true });
        break;
      }
      case "subscribeExit": {
        // Exit-only watch (used for task completion); no buffered/data replay.
        const { terminalId, subId } = req;
        const exitListener = () => sendEvent(subId, { type: "exit" });
        manager.addExitListener(terminalId, exitListener);
        subs.set(subId, { terminalId, exitListener });
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
  onShutdown: () => void
): net.Server {
  const server = net.createServer((socket) => {
    attachConnection(manager, socket, onShutdown);
  });
  return server;
}

async function main(): Promise<void> {
  const manager = new TerminalManager();
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
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logDaemon(`shutting down (${signal})`);
    // Step 5 will save logs + register tasks here before killing PTYs.
    manager.cleanup();
    server.close();
    removeDaemonInfo().finally(() => process.exit(0));
  };

  const server = createDaemonServer(manager, () => shutdown("shutdown-request"));

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

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
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
