/**
 * Client for the terminal daemon. Exposes the same method names as
 * `TerminalManager` but async (returning Promises), so the RPC handlers can
 * delegate to it almost unchanged. It connects to the daemon socket,
 * auto-spawning a detached daemon if none is running, and re-establishes live
 * subscriptions on reconnect.
 */

import net from "net";
import type { TerminalEvent } from "../shared/protocol.js";
import type { TerminalSessionInfo } from "../web/terminal-manager.js";
import logger from "../shared/logger.js";
import {
  FrameDecoder,
  encodeFrame,
  type DaemonRequest,
  type DaemonMessage,
  type DaemonResultMap,
  type SavedSessionLog,
} from "./terminal-daemon-protocol.js";
import { ensureDaemon, isDaemonRunning } from "./daemon-lifecycle.js";

export interface TerminalManagerClientOptions {
  /** Explicit socket path (tests / manual control). Defaults to the daemon's. */
  socketPath?: string;
  /** Auto-spawn a daemon if none is running (default true). Disabled in tests. */
  autoSpawn?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface LocalSubscription {
  op: "subscribe" | "subscribeExit";
  terminalId: string;
  onEvent: (event: TerminalEvent) => void;
}

export class TerminalManagerClient {
  private opts: TerminalManagerClientOptions;
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private decoder = new FrameDecoder();
  private pending = new Map<number, Pending>();
  private subs = new Map<number, LocalSubscription>();
  private nextReqId = 1;
  private nextSubId = 1;
  private closed = false;

  constructor(opts: TerminalManagerClientOptions = {}) {
    this.opts = opts;
  }

  // --- connection management ------------------------------------------------

  private async resolveSocketPath(): Promise<string> {
    if (this.opts.socketPath) return this.opts.socketPath;
    const info =
      this.opts.autoSpawn === false ? await isDaemonRunning() : await ensureDaemon();
    if (!info) throw new Error("Terminal daemon is not running");
    return info.socketPath;
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.closed) return Promise.reject(new Error("Terminal client is closed"));
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const socketPath = await this.resolveSocketPath();
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(socketPath);
        s.once("connect", () => resolve(s));
        s.once("error", reject);
      });

      this.decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => this.onDisconnect());
      socket.on("error", () => {
        /* surfaced via close */
      });

      this.socket = socket;
      this.connecting = null;

      // Re-establish any live subscriptions (reconnect after a daemon restart).
      for (const [subId, sub] of this.subs) {
        this.sendRaw({
          reqId: this.nextReqId++,
          op: sub.op,
          terminalId: sub.terminalId,
          subId,
        } as DaemonRequest).catch(() => {});
      }

      return socket;
    })();

    this.connecting.catch(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private onDisconnect(): void {
    this.socket = null;
    // Fail in-flight requests. We do NOT proactively reconnect here: that would
    // (a) race an intentional shutdown into respawning a fresh daemon, and
    // (b) silently re-subscribe to terminals that died with a crashed daemon.
    // Reconnection is lazy — the next request/subscribe re-establishes the
    // socket (and replays still-registered subscriptions). A crashed daemon's
    // PTYs are genuinely gone; we surface that rather than faking a reconnect.
    const err = new Error("Terminal daemon connection lost");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      logger.error("[terminal-client] failed to decode frame:", err);
      return;
    }
    for (const msg of messages) this.dispatch(msg as DaemonMessage);
  }

  private dispatch(msg: DaemonMessage): void {
    if (msg.type === "event") {
      const sub = this.subs.get(msg.subId);
      if (sub) sub.onEvent(msg.event);
      return;
    }
    // response
    const pending = this.pending.get(msg.reqId);
    if (!pending) return;
    this.pending.delete(msg.reqId);
    if ("error" in msg) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }

  /** Send a fully-formed request and await its response. */
  private async request<Op extends DaemonRequest["op"]>(
    req: Extract<DaemonRequest, { op: Op }>
  ): Promise<DaemonResultMap[Op]> {
    const result = await this.sendRaw(req);
    return result as DaemonResultMap[Op];
  }

  private async sendRaw(req: DaemonRequest): Promise<unknown> {
    const socket = await this.connect();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(req.reqId, { resolve, reject });
      socket.write(encodeFrame(req), (err) => {
        if (err) {
          this.pending.delete(req.reqId);
          reject(err);
        }
      });
    });
  }

  private newReqId(): number {
    return this.nextReqId++;
  }

  // --- manager-parity methods (async) --------------------------------------

  async createSession(
    terminalId: string,
    worktreePath: string,
    cols: number,
    rows: number,
    extraEnv?: Record<string, string>,
    initialCommand?: string,
    terminalLogDir?: string | null
  ): Promise<boolean> {
    const { existed } = await this.request({
      reqId: this.newReqId(),
      op: "createSession",
      terminalId,
      worktreePath,
      cols,
      rows,
      extraEnv,
      initialCommand,
      logDir: terminalLogDir,
    });
    return existed;
  }

  async sendData(terminalId: string, data: string): Promise<void> {
    await this.request({ reqId: this.newReqId(), op: "input", terminalId, data });
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    await this.request({ reqId: this.newReqId(), op: "resize", terminalId, cols, rows });
  }

  async closeSession(terminalId: string): Promise<void> {
    await this.request({ reqId: this.newReqId(), op: "close", terminalId });
  }

  async getSessionPid(terminalId: string): Promise<number | null> {
    const { pid } = await this.request({ reqId: this.newReqId(), op: "getSessionPid", terminalId });
    return pid;
  }

  async getSessionsForWorktree(worktreePath: string): Promise<string[]> {
    const { ids } = await this.request({ reqId: this.newReqId(), op: "listSessions", worktreePath });
    return ids;
  }

  async listAllSessions(): Promise<TerminalSessionInfo[]> {
    const { sessions } = await this.request({ reqId: this.newReqId(), op: "listAll" });
    return sessions;
  }

  async getSessionCountsByWorktree(): Promise<Record<string, number>> {
    const { counts } = await this.request({ reqId: this.newReqId(), op: "counts" });
    return counts;
  }

  async cleanupWorktree(worktreePath: string): Promise<void> {
    await this.request({ reqId: this.newReqId(), op: "cleanupWorktree", worktreePath });
  }

  async getBufferedOutput(terminalId: string): Promise<string> {
    const { output } = await this.request({ reqId: this.newReqId(), op: "getBufferedOutput", terminalId });
    return output;
  }

  async saveAllSessionLogs(logDir: string): Promise<SavedSessionLog[]> {
    const { saved } = await this.request({ reqId: this.newReqId(), op: "saveAllSessionLogs", logDir });
    return saved;
  }

  async setLabel(terminalId: string, label: string): Promise<void> {
    await this.request({ reqId: this.newReqId(), op: "setLabel", terminalId, label });
  }

  // --- subscriptions --------------------------------------------------------

  /**
   * Subscribe to a terminal's buffered output followed by its live data/exit
   * events. Returns an unsubscribe function.
   */
  async subscribe(
    terminalId: string,
    onEvent: (event: TerminalEvent) => void
  ): Promise<() => void> {
    const subId = this.nextSubId++;
    this.subs.set(subId, { op: "subscribe", terminalId, onEvent });
    await this.request({ reqId: this.newReqId(), op: "subscribe", terminalId, subId });
    return () => this.unsubscribe(subId);
  }

  /** Watch only for a terminal's exit (used for task completion tracking). */
  async onExit(terminalId: string, listener: () => void): Promise<() => void> {
    const subId = this.nextSubId++;
    this.subs.set(subId, {
      op: "subscribeExit",
      terminalId,
      onEvent: (event) => {
        if (event.type === "exit") listener();
      },
    });
    await this.request({ reqId: this.newReqId(), op: "subscribeExit", terminalId, subId });
    return () => this.unsubscribe(subId);
  }

  private unsubscribe(subId: number): void {
    if (!this.subs.has(subId)) return;
    this.subs.delete(subId);
    // Best-effort: if disconnected, the daemon already dropped it on socket close.
    if (this.socket && !this.socket.destroyed) {
      this.request({ reqId: this.newReqId(), op: "unsubscribe", subId }).catch(() => {});
    }
  }

  // --- daemon lifecycle controls -------------------------------------------

  /**
   * Whether there is a daemon to talk to. With an explicit socketPath (tests /
   * manual control) we assume the caller manages it; otherwise we check the
   * info file so we don't auto-spawn a daemon just to query or shut it down.
   */
  private async daemonPresent(): Promise<boolean> {
    if (this.opts.socketPath) return true;
    return (await isDaemonRunning()) !== null;
  }

  /** Number of live PTY sessions across all worktrees (0 if no daemon). */
  async getRunningCount(): Promise<number> {
    if (!(await this.daemonPresent())) return 0;
    const sessions = await this.listAllSessions();
    return sessions.length;
  }

  async ping(): Promise<boolean> {
    try {
      const { ok } = await this.request({ reqId: this.newReqId(), op: "ping" });
      return ok;
    } catch {
      return false;
    }
  }

  /** Ask the daemon to kill all PTYs and exit. No-op if no daemon is running. */
  async shutdownDaemon(): Promise<void> {
    if (!(await this.daemonPresent())) {
      this.closed = true;
      return;
    }
    try {
      await this.request({ reqId: this.newReqId(), op: "shutdown" });
    } catch {
      // daemon may exit/drop the socket before/while responding
    }
    // Mark closed so the socket-close from the daemon exiting cannot later be
    // turned into a reconnect that respawns a fresh daemon.
    this.closed = true;
  }

  /** Disconnect this client WITHOUT shutting down the daemon (PTYs survive). */
  disconnect(): void {
    this.closed = true;
    this.subs.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
