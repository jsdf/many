import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { createDaemonServer, type DaemonManager, type AgentManager } from "./terminal-daemon.js";
import { TerminalManagerClient } from "./terminal-client.js";
import type { AgentInfo } from "./claude-agent-manager.js";
import type { ClaudeUiEvent } from "../shared/protocol.js";

/**
 * In-memory stand-in for ClaudeAgentManager: records ops and lets the test
 * drive transcript events, without spawning a real claude process.
 */
class FakeAgentManager implements AgentManager {
  agents = new Map<
    string,
    { info: AgentInfo; buffer: ClaudeUiEvent[]; listeners: Set<(e: ClaudeUiEvent) => void> }
  >();
  sent: Array<{ agentId: string; message: string }> = [];

  create(agentId: string, worktreePath: string, opts: { prompt?: string; claudeBin?: string }): AgentInfo {
    const info: AgentInfo = { agentId, worktreePath, sessionId: null, title: opts.prompt };
    this.agents.set(agentId, { info, buffer: [], listeners: new Set() });
    if (opts.prompt) this.push(agentId, { type: "prompt", text: opts.prompt });
    return info;
  }
  send(agentId: string, message: string): void {
    this.sent.push({ agentId, message });
    this.push(agentId, { type: "prompt", text: message });
  }
  subscribe(agentId: string, listener: (e: ClaudeUiEvent) => void): () => void {
    const a = this.agents.get(agentId);
    if (!a) return () => {};
    for (const e of a.buffer) listener(e);
    a.listeners.add(listener);
    return () => a.listeners.delete(listener);
  }
  list(): AgentInfo[] {
    return [...this.agents.values()].map((a) => a.info);
  }
  cleanup(): void {
    this.agents.clear();
  }

  // --- test driver ---
  push(agentId: string, event: ClaudeUiEvent): void {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.buffer.push(event);
    for (const l of a.listeners) l(event);
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TerminalManagerClient agent ops against a fake daemon", () => {
  let server: net.Server;
  let socketPath: string;
  let agents: FakeAgentManager;
  let client: TerminalManagerClient;

  beforeEach(async () => {
    agents = new FakeAgentManager();
    socketPath = path.join(os.tmpdir(), `many-agent-rpc-${process.pid}-${Date.now()}.sock`);
    server = createDaemonServer({} as unknown as DaemonManager, () => {}, undefined, agents);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    client = new TerminalManagerClient({ socketPath, autoSpawn: false });
  });

  afterEach(async () => {
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.unlink(socketPath).catch(() => {});
  });

  it("agentCreate returns the agent info", async () => {
    const info = await client.agentCreate("a1", "/wt", { prompt: "hello", claudeBin: "claude" });
    expect(info).toEqual({ agentId: "a1", worktreePath: "/wt", sessionId: null, title: "hello" });
  });

  it("agentSend forwards the message to the manager", async () => {
    await client.agentCreate("a1", "/wt", {});
    await client.agentSend("a1", "next turn");
    expect(agents.sent).toEqual([{ agentId: "a1", message: "next turn" }]);
  });

  it("agentList returns live agents", async () => {
    await client.agentCreate("a1", "/wtA", {});
    await client.agentCreate("a2", "/wtB", {});
    const list = await client.agentList();
    expect(list.map((a) => a.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("agentSubscribe replays buffered transcript then delivers live events", async () => {
    await client.agentCreate("a1", "/wt", { prompt: "hi" });

    const received: ClaudeUiEvent[] = [];
    await client.agentSubscribe("a1", (e) => received.push(e));

    // The buffered "prompt" event replays before/as the subscribe resolves.
    await waitFor(() => received.length >= 1);
    expect(received[0]).toEqual({ type: "prompt", text: "hi" });

    agents.push("a1", { type: "assistant", content: [{ type: "text", text: "live" }] });
    await waitFor(() => received.some((e) => e.type === "assistant"));
    expect(received.some((e) => e.type === "assistant" && e.content[0].type === "text" && e.content[0].text === "live")).toBe(true);
  });
});
