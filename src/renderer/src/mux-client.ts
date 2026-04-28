/**
 * Lightweight WebSocket RPC client for talking to the mux server directly
 * from the many renderer. Used for notes and steps (work items).
 */

import { getRpcClient } from "./rpc-client";

// --- Mux wire types (subset of mux's protocol) ---

interface MuxWorkItem {
  id: string;
  repo: string;
  branch: string;
  linearId: string;
  linearUrl: string;
  prNumber: number | null;
  prUrl: string;
  title: string;
  notes: string;
  status: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  sessionCount: number;
}

interface MuxWorkItemStep {
  id: string;
  workItemId: string;
  text: string;
  completed: boolean;
  sortOrder: number;
  createdAt: number;
}

interface MuxWorkItemDetail {
  item: MuxWorkItem;
  steps: MuxWorkItemStep[];
  sessions: unknown[];
}

// --- Generic untyped RPC client ---

type PendingQuery = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class MuxRpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingQuery>();
  private sendQueue: Array<{ id: number; type: string; procedure: string; input: unknown }> = [];
  private url: string;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      const queued = this.sendQueue.splice(0);
      for (const msg of queued) this.send(msg);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "result") {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            p.resolve(msg.data);
          }
        } else if (msg.type === "error") {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            p.reject(new Error(msg.error));
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    this.ws.onerror = () => {};
  }

  query(procedure: string, input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Mux RPC timeout"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, type: "query", procedure, input });
    });
  }

  private send(msg: { id: number; type: string; procedure: string; input: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.sendQueue.push(msg);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Client destroyed"));
    }
    this.pending.clear();
  }
}

// --- Singleton client + repo cache per repoPath ---

let muxClient: MuxRpcClient | null = null;
let muxUrlCache: string | null | undefined;
const repoCache = new Map<string, string | null>();

async function ensureMuxInfo(repoPath: string): Promise<{ client: MuxRpcClient; repo: string } | null> {
  if (muxUrlCache === undefined) {
    try {
      const result = await getRpcClient().query("settings.muxUrl", { repoPath });
      muxUrlCache = result.wsUrl;
      if (result.repo) repoCache.set(repoPath, result.repo);
    } catch {
      muxUrlCache = null;
    }
  }

  if (!muxUrlCache) return null;

  if (!muxClient) {
    muxClient = new MuxRpcClient(muxUrlCache);
  }

  let repo = repoCache.get(repoPath);
  if (repo === undefined) {
    try {
      const result = await getRpcClient().query("settings.muxUrl", { repoPath });
      repo = result.repo;
      repoCache.set(repoPath, repo);
    } catch {
      return null;
    }
  }
  if (!repo) return null;

  return { client: muxClient, repo };
}

function normalizeBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

// --- Typed helper functions ---

export interface TrackedStep {
  id: string;
  type: string;
  data: Record<string, unknown>;
  completed: boolean;
}

export interface MuxBranchInfo {
  notes: string;
  linearId: string;
  linearUrl: string;
  prUrl: string;
  title: string;
  workItemId: string | null;
}

export async function getMuxBranchInfo(repoPath: string, branch: string): Promise<MuxBranchInfo | null> {
  const info = await ensureMuxInfo(repoPath);
  if (!info) return null;
  try {
    const result = await info.client.query("workItemByBranch", { branch: normalizeBranch(branch) }) as { item: MuxWorkItem | null };
    if (!result.item) return null;
    return {
      notes: result.item.notes,
      linearId: result.item.linearId,
      linearUrl: result.item.linearUrl,
      prUrl: result.item.prUrl,
      title: result.item.title,
      workItemId: result.item.id,
    };
  } catch {
    return null;
  }
}

export async function getMuxNotes(repoPath: string, branch: string): Promise<string> {
  const branchInfo = await getMuxBranchInfo(repoPath, branch);
  return branchInfo?.notes ?? "";
}

export async function setMuxNotes(repoPath: string, branch: string, notes: string): Promise<void> {
  const info = await ensureMuxInfo(repoPath);
  if (!info) return;
  try {
    await info.client.query("workItemUpsert", {
      repo: info.repo,
      branch: normalizeBranch(branch),
      notes,
    });
  } catch {
    // silently fail if mux unavailable
  }
}

export async function getMuxSteps(repoPath: string, branch: string): Promise<TrackedStep[]> {
  const info = await ensureMuxInfo(repoPath);
  if (!info) return [];
  try {
    const byBranch = await info.client.query("workItemByBranch", { branch: normalizeBranch(branch) }) as { item: MuxWorkItem | null };
    if (!byBranch.item) return [];
    const detail = await info.client.query("workItemDetail", { id: byBranch.item.id }) as MuxWorkItemDetail;
    return detail.steps.map((s) => ({
      id: s.id,
      type: "text",
      data: { text: s.text },
      completed: s.completed,
    }));
  } catch {
    return [];
  }
}

export async function addMuxStep(repoPath: string, branch: string, text: string): Promise<string | null> {
  const info = await ensureMuxInfo(repoPath);
  if (!info) return null;
  try {
    // Ensure work item exists
    const item = await info.client.query("workItemUpsert", {
      repo: info.repo,
      branch: normalizeBranch(branch),
    }) as MuxWorkItem;
    const step = await info.client.query("workItemAddStep", {
      workItemId: item.id,
      text,
    }) as MuxWorkItemStep;
    return step.id;
  } catch {
    return null;
  }
}

export async function updateMuxStep(id: string, text?: string, completed?: boolean): Promise<void> {
  if (!muxClient) return;
  try {
    await muxClient.query("workItemUpdateStep", { id, text, completed });
  } catch {
    // silently fail
  }
}

export async function deleteMuxStep(id: string): Promise<void> {
  if (!muxClient) return;
  try {
    await muxClient.query("workItemDeleteStep", { id });
  } catch {
    // silently fail
  }
}
