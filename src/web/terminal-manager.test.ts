import { describe, it, expect, vi } from "vitest";
import { TerminalManager } from "./terminal-manager.js";

describe("TerminalManager.createSession", () => {
  it("rejects an empty/invalid terminalId instead of spawning a null-keyed session", () => {
    const manager = new TerminalManager();
    // @ts-expect-error - exercising the runtime guard against bad callers
    expect(() => manager.createSession(null, "/tmp", 80, 24)).toThrow(/invalid terminalId/);
    expect(() => manager.createSession("", "/tmp", 80, 24)).toThrow(/invalid terminalId/);
    expect(manager.getSessionsForWorktree("/tmp")).toEqual([]);
  });
});

describe("TerminalManager activity timestamps", () => {
  it("exposes createdAt/lastDataAt and advances lastDataAt on PTY output", async () => {
    const manager = new TerminalManager();
    manager.createSession("ts1", "/tmp", 80, 24);

    const before = manager.listAllSessions().find((s) => s.terminalId === "ts1")!;
    expect(before.createdAt).toBeGreaterThan(0);
    expect(before.lastDataAt).toBe(before.createdAt);

    // Wait for real shell output triggered by an echo, then confirm the
    // most-recent-data timestamp moved forward.
    await new Promise<void>((resolve) => {
      manager.addDataListener("ts1", () => resolve());
      manager.sendData("ts1", "echo hi\n");
    });

    const after = manager.listAllSessions().find((s) => s.terminalId === "ts1")!;
    expect(after.lastDataAt).toBeGreaterThanOrEqual(before.lastDataAt);

    manager.closeSession("ts1");
  });
});

describe("TerminalManager auto-run input buffering", () => {
  it("buffers user input until the initial command is submitted, then flushes it in order", () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager();
      manager.createSession("t1", "/tmp", 80, 24, undefined, "claude");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = (manager as any).sessions.get("t1");
      const writes: string[] = [];
      session.ptyProcess.write = (d: string) => writes.push(d);

      // User types before the 500ms auto-run fires: input must be buffered.
      manager.sendData("t1", "h");
      manager.sendData("t1", "i");
      expect(writes).toEqual([]);

      // Once the delay elapses, the command goes first, then buffered input.
      vi.advanceTimersByTime(500);
      expect(writes).toEqual(["claude\n", "h", "i"]);

      // After the flush, input writes straight through.
      manager.sendData("t1", "x");
      expect(writes).toEqual(["claude\n", "h", "i", "x"]);

      manager.closeSession("t1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not buffer input when there is no initial command", () => {
    const manager = new TerminalManager();
    manager.createSession("t2", "/tmp", 80, 24);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = (manager as any).sessions.get("t2");
    const writes: string[] = [];
    session.ptyProcess.write = (d: string) => writes.push(d);

    manager.sendData("t2", "h");
    expect(writes).toEqual(["h"]);

    manager.closeSession("t2");
  });
});
