import { describe, it, expect } from "vitest";
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
