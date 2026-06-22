import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { createDaemonServer, type DaemonManager } from "./terminal-daemon.js";
import { TerminalManagerClient } from "./terminal-client.js";
import type { TerminalSessionInfo } from "../web/terminal-manager.js";
import type { TerminalEvent } from "../shared/protocol.js";
import type { SavedSessionLog } from "./terminal-daemon-protocol.js";

/** In-memory stand-in for TerminalManager that lets the test drive PTY events. */
class FakeManager implements DaemonManager {
  sessions = new Map<
    string,
    {
      worktreePath: string;
      pid: number;
      buffered: string;
      dataListeners: Set<(d: string) => void>;
      exitListeners: Set<() => void>;
    }
  >();
  inputs: Array<{ terminalId: string; data: string }> = [];
  resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
  private nextPid = 1000;

  createSession(terminalId: string, worktreePath: string): boolean {
    if (this.sessions.has(terminalId)) return true;
    this.sessions.set(terminalId, {
      worktreePath,
      pid: this.nextPid++,
      buffered: "",
      dataListeners: new Set(),
      exitListeners: new Set(),
    });
    return false;
  }
  sendData(terminalId: string, data: string): void {
    this.inputs.push({ terminalId, data });
  }
  resize(terminalId: string, cols: number, rows: number): void {
    this.resizes.push({ terminalId, cols, rows });
  }
  closeSession(terminalId: string): void {
    this.sessions.delete(terminalId);
  }
  getSessionPid(terminalId: string): number | null {
    return this.sessions.get(terminalId)?.pid ?? null;
  }
  getSessionsForWorktree(worktreePath: string): string[] {
    return [...this.sessions.entries()]
      .filter(([, s]) => s.worktreePath === worktreePath)
      .map(([id]) => id);
  }
  listAllSessions(): TerminalSessionInfo[] {
    return [...this.sessions.entries()].map(([terminalId, s]) => ({
      terminalId,
      worktreePath: s.worktreePath,
      createdAt: 0,
      lastInputAt: 0,
    }));
  }
  getSessionCountsByWorktree(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of this.sessions.values()) {
      counts[s.worktreePath] = (counts[s.worktreePath] || 0) + 1;
    }
    return counts;
  }
  setLabel(terminalId: string, label: string): void {
    const s = this.sessions.get(terminalId);
    if (s) (s as any).userLabel = label || undefined;
  }
  cleanupWorktree(worktreePath: string): void {
    for (const id of this.getSessionsForWorktree(worktreePath)) this.closeSession(id);
  }
  getBufferedOutput(terminalId: string): string {
    return this.sessions.get(terminalId)?.buffered ?? "";
  }
  async saveAllSessionLogs(logDir: string): Promise<SavedSessionLog[]> {
    return [...this.sessions.entries()].map(([terminalId, s]) => ({
      terminalId,
      worktreePath: s.worktreePath,
      logFile: path.join(logDir, `${terminalId}.log`),
    }));
  }
  addDataListener(terminalId: string, listener: (d: string) => void): void {
    this.sessions.get(terminalId)?.dataListeners.add(listener);
  }
  removeDataListener(terminalId: string, listener: (d: string) => void): void {
    this.sessions.get(terminalId)?.dataListeners.delete(listener);
  }
  addExitListener(terminalId: string, listener: () => void): void {
    this.sessions.get(terminalId)?.exitListeners.add(listener);
  }
  removeExitListener(terminalId: string, listener: () => void): void {
    this.sessions.get(terminalId)?.exitListeners.delete(listener);
  }
  cleanup(): void {
    this.sessions.clear();
  }

  // --- test drivers ---
  emitData(terminalId: string, data: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    s.buffered += data; // mirror TerminalManager: output is buffered too
    for (const l of s.dataListeners) l(data);
  }
  emitExit(terminalId: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    for (const l of s.exitListeners) l();
    this.sessions.delete(terminalId);
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TerminalManagerClient against a fake daemon", () => {
  let server: net.Server;
  let socketPath: string;
  let manager: FakeManager;
  let client: TerminalManagerClient;
  let shutdownCalled = false;

  beforeEach(async () => {
    manager = new FakeManager();
    shutdownCalled = false;
    socketPath = path.join(os.tmpdir(), `many-test-${process.pid}-${Date.now()}.sock`);
    server = createDaemonServer(manager, () => {
      shutdownCalled = true;
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    client = new TerminalManagerClient({ socketPath, autoSpawn: false });
  });

  afterEach(async () => {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.unlink(socketPath).catch(() => {});
  });

  it("createSession reports existed=false then true on reconnect", async () => {
    expect(await client.createSession("t1", "/wt", 80, 24)).toBe(false);
    expect(await client.createSession("t1", "/wt", 80, 24)).toBe(true);
  });

  it("forwards input and resize to the manager", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    await client.sendData("t1", "echo hi\n");
    await client.resize("t1", 120, 40);
    expect(manager.inputs).toEqual([{ terminalId: "t1", data: "echo hi\n" }]);
    expect(manager.resizes).toEqual([{ terminalId: "t1", cols: 120, rows: 40 }]);
  });

  it("returns the session pid", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    const pid = await client.getSessionPid("t1");
    expect(pid).toBe(1000);
  });

  it("closeSession removes the session", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    await client.closeSession("t1");
    expect(await client.listAllSessions()).toEqual([]);
  });

  it("listAll returns all live sessions", async () => {
    await client.createSession("t1", "/wtA", 80, 24);
    await client.createSession("t2", "/wtB", 80, 24);
    const all = await client.listAllSessions();
    expect(all.map((s) => s.terminalId).sort()).toEqual(["t1", "t2"]);
  });

  it("subscribe delivers buffered output before live data, then exit, in order", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    manager.emitData("t1", "BUFFERED"); // accumulates before any subscriber

    const events: TerminalEvent[] = [];
    await client.subscribe("t1", (e) => events.push(e));

    // The buffered replay is sent before the subscribe response, so it has
    // already arrived by the time subscribe() resolves.
    await waitFor(() => events.length >= 1);

    manager.emitData("t1", "LIVE");
    manager.emitExit("t1");
    await waitFor(() => events.some((e) => e.type === "exit"));

    expect(events).toEqual([
      { type: "buffered", data: "BUFFERED" },
      { type: "data", data: "LIVE" },
      { type: "exit" },
    ]);
  });

  it("subscribe with no buffered output only delivers live events", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    const events: TerminalEvent[] = [];
    await client.subscribe("t1", (e) => events.push(e));
    manager.emitData("t1", "X");
    await waitFor(() => events.length >= 1);
    expect(events).toEqual([{ type: "data", data: "X" }]);
  });

  it("unsubscribe stops further events", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    const events: TerminalEvent[] = [];
    const unsub = await client.subscribe("t1", (e) => events.push(e));
    manager.emitData("t1", "A");
    await waitFor(() => events.length >= 1);
    unsub();
    await waitFor(() => manager.sessions.get("t1")!.dataListeners.size === 0);
    manager.emitData("t1", "B");
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ type: "data", data: "A" }]);
  });

  it("onExit fires only on exit, without buffered/data replay", async () => {
    await client.createSession("t1", "/wt", 80, 24);
    manager.emitData("t1", "noise");
    let exited = 0;
    await client.onExit("t1", () => exited++);
    manager.emitData("t1", "more");
    manager.emitExit("t1");
    await waitFor(() => exited === 1);
    expect(exited).toBe(1);
  });

  it("shutdownDaemon triggers the daemon's shutdown handler", async () => {
    await client.shutdownDaemon();
    await waitFor(() => shutdownCalled);
    expect(shutdownCalled).toBe(true);
  });
});
