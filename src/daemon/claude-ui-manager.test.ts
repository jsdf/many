import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClaudeUiEvent } from "../shared/protocol.js";

// A fake ClaudeSession (EventEmitter) so the manager never spawns a real claude.
// Every constructed instance is recorded so tests can drive its events.
const h = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  class FakeSession extends EventEmitter {
    options: unknown;
    prompts: string[] = [];
    disposed = false;
    reset = vi.fn();
    interrupt = vi.fn();
    setPermissionMode = vi.fn();
    generateSessionTitle = vi.fn(() => Promise.resolve(undefined));
    constructor(options: unknown) {
      super();
      this.options = options;
    }
    prompt(p: string): Promise<unknown> {
      this.prompts.push(p);
      return Promise.resolve({});
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  const sessions: FakeSession[] = [];
  return { FakeSession, sessions };
});

vi.mock("@libclaude/core", () => ({
  ClaudeSession: class extends h.FakeSession {
    constructor(options: unknown) {
      super(options);
      h.sessions.push(this as unknown as InstanceType<typeof h.FakeSession>);
    }
  },
}));

import { ClaudeUiManager } from "./claude-ui-manager.js";

/** Collect every event the manager currently holds for a session (buffer replay). */
function replay(mgr: ClaudeUiManager, sessionId: string): ClaudeUiEvent[] {
  const events: ClaudeUiEvent[] = [];
  mgr.subscribe(sessionId, (e) => events.push(e))();
  return events;
}

describe("ClaudeUiManager", () => {
  let mgr: ClaudeUiManager;

  beforeEach(() => {
    h.sessions.length = 0;
    mgr = new ClaudeUiManager();
  });

  afterEach(() => {
    mgr.cleanup();
  });

  it("create spawns a session and is idle (no turn sent)", () => {
    const info = mgr.create("s1", "/wt", "claude");
    expect(info).toEqual({ sessionId: "s1", worktreePath: "/wt", title: undefined });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].prompts).toEqual([]);
  });

  it("create is a no-op if the session already exists (does not respawn)", () => {
    mgr.create("s1", "/wt", "claude");
    mgr.create("s1", "/wt", "claude");
    expect(h.sessions).toHaveLength(1);
  });

  it("send buffers a prompt event and replays it on subscribe", () => {
    mgr.create("s1", "/wt");
    mgr.send("s1", "do the thing");
    expect(h.sessions[0].prompts).toEqual(["do the thing"]);
    expect(replay(mgr, "s1")).toEqual([{ type: "prompt", text: "do the thing" }]);
  });

  it("subscribe replays buffered transcript + last status, then delivers live events", () => {
    mgr.create("s1", "/wt");
    mgr.send("s1", "hi");
    const session = h.sessions[0];
    session.emit("status", { ready: true, busy: true, queued: 0, sessionId: "cli-1" });
    session.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "one" }] },
    });

    const received: ClaudeUiEvent[] = [];
    const unsub = mgr.subscribe("s1", (e) => received.push(e));

    expect(received).toEqual([
      { type: "prompt", text: "hi" },
      { type: "assistant", content: [{ type: "text", text: "one" }] },
      { type: "status", ready: true, busy: true, queued: 0, sessionId: "cli-1" },
    ]);

    unsub();
    session.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "after unsub" }] },
    });
    expect(
      received.some(
        (e) => e.type === "assistant" && e.content[0].type === "text" && e.content[0].text === "after unsub"
      )
    ).toBe(false);
  });

  it("resume seeds the buffer with the provided transcript and does not respawn if already live", () => {
    const seed: ClaudeUiEvent[] = [{ type: "prompt", text: "earlier prompt" }];
    const info = mgr.resume("s1", "/wt", seed, { title: "earlier prompt", firstPrompt: "earlier prompt" });
    expect(info).toEqual({ sessionId: "s1", worktreePath: "/wt", title: "earlier prompt" });
    expect(replay(mgr, "s1")).toEqual(seed);
    expect(h.sessions[0].options).toMatchObject({ resume: "s1" });

    // Already live: no-op, does not spawn a second session.
    const again = mgr.resume("s1", "/wt", [], {});
    expect(again).toEqual(info);
    expect(h.sessions).toHaveLength(1);
  });

  it("list filters sessions by worktree", () => {
    mgr.create("s1", "/wtA");
    mgr.create("s2", "/wtB");
    mgr.create("s3", "/wtA");
    expect(mgr.list("/wtA").map((s) => s.sessionId).sort()).toEqual(["s1", "s3"]);
  });

  it("listAll returns every live session", () => {
    mgr.create("s1", "/wtA");
    mgr.create("s2", "/wtB");
    expect(mgr.listAll().map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("close disposes the session, clears listeners, and removes it", () => {
    mgr.create("s1", "/wt");
    const session = h.sessions[0];
    mgr.subscribe("s1", () => {});
    mgr.close("s1");
    expect(session.disposed).toBe(true);
    expect(mgr.list("/wt")).toEqual([]);
    // send on a closed session throws rather than silently reusing a stale entry.
    expect(() => mgr.send("s1", "nope")).toThrow(/not found/);
  });

  it("send throws for an unknown session", () => {
    expect(() => mgr.send("nope", "hi")).toThrow(/not found/);
  });

  it("interrupt, setPermissionMode, and reset delegate to the underlying session", () => {
    mgr.create("s1", "/wt");
    const session = h.sessions[0];
    mgr.interrupt("s1");
    mgr.setPermissionMode("s1", "plan");
    mgr.reset("s1");
    expect(session.interrupt).toHaveBeenCalled();
    expect(session.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(session.reset).toHaveBeenCalled();
  });

  it("reset clears the buffered transcript", () => {
    mgr.create("s1", "/wt");
    mgr.send("s1", "hi");
    mgr.reset("s1");
    expect(replay(mgr, "s1")).toEqual([]);
  });

  it("cleanup disposes every session", () => {
    mgr.create("s1", "/wtA");
    mgr.create("s2", "/wtB");
    mgr.cleanup();
    expect(h.sessions.every((s) => s.disposed)).toBe(true);
    expect(mgr.listAll()).toEqual([]);
  });
});
