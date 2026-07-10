import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import type { ClaudeUiEvent } from "../shared/protocol.js";

// A fake ClaudeSession (EventEmitter) so the manager never spawns a real claude.
// Every constructed instance is recorded so tests can drive its events.
const h = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  const nodePath = require("node:path");
  const nodeOs = require("node:os");
  const logDir = nodePath.join(nodeOs.tmpdir(), `many-agent-test-${process.pid}`);
  class FakeSession extends EventEmitter {
    options: unknown;
    prompts: string[] = [];
    disposed = false;
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
  return { FakeSession, sessions, logDir };
});

vi.mock("@libclaude/core", () => ({
  ClaudeSession: class extends h.FakeSession {
    constructor(options: unknown) {
      super(options);
      h.sessions.push(this as unknown as InstanceType<typeof h.FakeSession>);
    }
  },
}));

vi.mock("../cli/task-registry.js", () => ({
  getAgentLogDir: () => h.logDir,
  getAgentTranscriptPath: (id: string) => path.join(h.logDir, `${id}.ndjson`),
}));

import { ClaudeAgentManager } from "./claude-agent-manager.js";

/** Collect every event the manager currently holds for an agent (buffer replay). */
function replay(mgr: ClaudeAgentManager, agentId: string): ClaudeUiEvent[] {
  const events: ClaudeUiEvent[] = [];
  mgr.subscribe(agentId, (e) => events.push(e))();
  return events;
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function readTranscript(agentId: string): ClaudeUiEvent[] {
  const file = path.join(h.logDir, `${agentId}.ndjson`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ClaudeUiEvent);
}

describe("ClaudeAgentManager", () => {
  let mgr: ClaudeAgentManager;

  beforeEach(() => {
    h.sessions.length = 0;
    mgr = new ClaudeAgentManager();
  });

  afterEach(() => {
    mgr.cleanup();
  });

  // Cleaned once at the end rather than per-test: transcript writes flush
  // asynchronously, so removing the dir between tests would race pending flushes
  // (which append-mode reopens would then mix into a reused filename).
  afterAll(() => {
    fs.rmSync(h.logDir, { recursive: true, force: true });
  });

  it("create with a prompt sends the first turn and buffers it as a transcript event", () => {
    const info = mgr.create("a1", "/wt", { prompt: "do the thing", claudeBin: "claude" });
    expect(info.agentId).toBe("a1");
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].prompts).toEqual(["do the thing"]);
    expect(replay(mgr, "a1")).toEqual([{ type: "prompt", text: "do the thing" }]);
  });

  it("create without a prompt spawns an idle session (no turn sent)", () => {
    mgr.create("a1", "/wt", {});
    expect(h.sessions[0].prompts).toEqual([]);
    expect(replay(mgr, "a1")).toEqual([]);
  });

  it("maps and buffers assistant events, but not status/init", () => {
    mgr.create("a1", "/wt", {});
    const session = h.sessions[0];
    session.emit("status", { ready: true, busy: false, queued: 0, sessionId: "sess-1" });
    session.emit("event", { type: "system", subtype: "init", session_id: "sess-1" });
    session.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    });

    // init is dropped, status is not buffered (replayed separately as lastStatus),
    // the assistant text is buffered.
    expect(replay(mgr, "a1")).toEqual([
      { type: "assistant", content: [{ type: "text", text: "hello" }] },
      { type: "status", ready: true, busy: false, queued: 0, sessionId: "sess-1" },
    ]);
    // sessionId is captured from the status event.
    expect(mgr.get("a1")?.sessionId).toBe("sess-1");
  });

  it("subscribe replays buffered transcript + last status, then delivers live events", () => {
    mgr.create("a1", "/wt", { prompt: "hi" });
    const session = h.sessions[0];
    session.emit("status", { ready: true, busy: true, queued: 0, sessionId: "s1" });
    session.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "one" }] },
    });

    const received: ClaudeUiEvent[] = [];
    const unsub = mgr.subscribe("a1", (e) => received.push(e));

    expect(received).toEqual([
      { type: "prompt", text: "hi" },
      { type: "assistant", content: [{ type: "text", text: "one" }] },
      { type: "status", ready: true, busy: true, queued: 0, sessionId: "s1" },
    ]);

    session.emit("event", { type: "result", is_error: false });
    expect(received[received.length - 1]).toMatchObject({ type: "result", isError: false });

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

  it("send enqueues another turn on an existing agent", () => {
    mgr.create("a1", "/wt", {});
    mgr.send("a1", "second turn");
    expect(h.sessions[0].prompts).toEqual(["second turn"]);
    expect(replay(mgr, "a1")).toEqual([{ type: "prompt", text: "second turn" }]);
  });

  it("send throws for an unknown agent", () => {
    expect(() => mgr.send("nope", "hi")).toThrow(/not found/);
  });

  it("close disposes the session and drops the agent", () => {
    mgr.create("a1", "/wt", {});
    const session = h.sessions[0];
    mgr.close("a1");
    expect(session.disposed).toBe(true);
    expect(mgr.get("a1")).toBeUndefined();
  });

  it("list reports live agents", () => {
    mgr.create("a1", "/wtA", {});
    mgr.create("a2", "/wtB", { prompt: "p" });
    expect(mgr.list().map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("persists transcript events to the on-disk NDJSON file (for tail without a live daemon)", async () => {
    // Unique id so no other test's async flush lands in this file.
    mgr.create("persist-file", "/wt", { prompt: "hi" });
    h.sessions[0].emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "answer" }] },
    });
    // The write stream flushes asynchronously; wait for the file to appear.
    await waitFor(() => readTranscript("persist-file").length >= 2);
    expect(readTranscript("persist-file")).toEqual([
      { type: "prompt", text: "hi" },
      { type: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });
});
