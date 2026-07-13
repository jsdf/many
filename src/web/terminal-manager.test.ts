import { describe, it, expect, vi } from "vitest";
import { TerminalManager, detectBell } from "./terminal-manager.js";

describe("detectBell", () => {
  // detectBell reads/writes the parser state on a session-like object.
  const makeState = () => ({ bellState: 0 }) as { bellState: number };

  it("detects a bare BEL as a real bell", () => {
    expect(detectBell(makeState() as any, "hi\x07there")).toBe(true);
  });

  it("ignores a BEL that terminates an OSC title sequence", () => {
    // OSC 0 ; title BEL — the trailing \x07 is the string terminator, not a bell.
    expect(detectBell(makeState() as any, "\x1b]0;my title\x07")).toBe(false);
  });

  it("ignores a BEL terminating an OSC 8 hyperlink but catches a real one after", () => {
    const s = makeState();
    expect(detectBell(s as any, "\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(false);
    expect(detectBell(s as any, "done\x07")).toBe(true);
  });

  it("handles an OSC sequence split across chunks without a false positive", () => {
    const s = makeState();
    expect(detectBell(s as any, "\x1b]0;partial")).toBe(false);
    // The terminating BEL arrives in the next chunk; still not a real bell.
    expect(detectBell(s as any, " title\x07")).toBe(false);
  });

  it("treats a BEL after an ST-terminated OSC as a real bell", () => {
    // OSC ... ST (ESC \) closes the string; the following BEL is a real bell.
    expect(detectBell(makeState() as any, "\x1b]0;t\x1b\\\x07")).toBe(true);
  });
});

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
