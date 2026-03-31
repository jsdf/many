// Automation registry - persistent tracking of automation runs and work items
import { promises as fs, constants as fsConstants } from "fs";
import { open } from "fs/promises";
import path from "path";
import { getDataPath } from "./config.js";

export type WorkItemStatus = "pending" | "running" | "completed" | "failed";
export type AutomationRunStatus =
  | "producing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkItem {
  id: string;
  prompt: string;
  status: WorkItemStatus;
  taskId?: string;
  worktreePath?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  repoPath: string;
  status: AutomationRunStatus;
  startedAt: string;
  endedAt?: string;
  producerTaskId?: string;
  producerWorktreePath?: string;
  workItems: WorkItem[];
}

interface AutomationRegistryData {
  runs: AutomationRun[];
}

const defaultRegistryData: AutomationRegistryData = { runs: [] };

function getRegistryFilePath(): string {
  return path.join(getDataPath(), "automation-registry.json");
}

async function loadRegistry(): Promise<AutomationRegistryData> {
  const filePath = getRegistryFilePath();
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return { ...defaultRegistryData, ...JSON.parse(data) };
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    ) {
      return defaultRegistryData;
    }
    throw new Error(
      `Failed to load automation registry: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function saveRegistry(data: AutomationRegistryData): Promise<void> {
  const filePath = getRegistryFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
}

// File-based locking — same pattern as task-registry.ts
const LOCK_STALE_MS = 10_000;

async function acquireLock(): Promise<void> {
  const lockPath = getRegistryFilePath() + ".lock";
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fh = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      );
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }

      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }

  await fs.unlink(getRegistryFilePath() + ".lock").catch(() => {});
  throw new Error(
    "Failed to acquire automation registry lock after max attempts"
  );
}

async function releaseLock(): Promise<void> {
  await fs.unlink(getRegistryFilePath() + ".lock").catch(() => {});
}

async function withRegistry<T>(
  fn: (registry: AutomationRegistryData) => Promise<{ result: T; save: boolean }>
): Promise<T> {
  await acquireLock();
  try {
    const registry = await loadRegistry();
    const { result, save } = await fn(registry);
    if (save) {
      await saveRegistry(registry);
    }
    return result;
  } finally {
    await releaseLock();
  }
}

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

export async function createRun(
  fields: Omit<AutomationRun, "id" | "startedAt" | "workItems">
): Promise<AutomationRun> {
  return withRegistry(async (registry) => {
    const run: AutomationRun = {
      id: generateId("auto"),
      startedAt: new Date().toISOString(),
      workItems: [],
      ...fields,
    };
    registry.runs.push(run);
    return { result: run, save: true };
  });
}

export async function updateRun(
  id: string,
  updates: Partial<Pick<AutomationRun, "status" | "endedAt" | "producerTaskId" | "producerWorktreePath">>
): Promise<void> {
  await withRegistry(async (registry) => {
    const run = registry.runs.find((r) => r.id === id);
    if (!run) return { result: undefined, save: false };
    Object.assign(run, updates);
    if (updates.status && updates.status !== "producing" && updates.status !== "running") {
      run.endedAt = run.endedAt || new Date().toISOString();
    }
    return { result: undefined, save: true };
  });
}

export async function addWorkItems(
  runId: string,
  prompts: string[]
): Promise<WorkItem[]> {
  return withRegistry(async (registry) => {
    const run = registry.runs.find((r) => r.id === runId);
    if (!run) return { result: [], save: false };

    const items: WorkItem[] = prompts.map((prompt) => ({
      id: generateId("wi"),
      prompt,
      status: "pending" as const,
    }));
    run.workItems.push(...items);
    return { result: items, save: true };
  });
}

export async function updateWorkItem(
  runId: string,
  workItemId: string,
  updates: Partial<Pick<WorkItem, "status" | "taskId" | "worktreePath">>
): Promise<void> {
  await withRegistry(async (registry) => {
    const run = registry.runs.find((r) => r.id === runId);
    if (!run) return { result: undefined, save: false };
    const item = run.workItems.find((i) => i.id === workItemId);
    if (!item) return { result: undefined, save: false };
    Object.assign(item, updates);
    return { result: undefined, save: true };
  });
}

export async function getRun(id: string): Promise<AutomationRun | null> {
  const registry = await loadRegistry();
  return registry.runs.find((r) => r.id === id) || null;
}

export async function listRuns(filter?: {
  repoPath?: string;
  status?: AutomationRunStatus;
}): Promise<AutomationRun[]> {
  const registry = await loadRegistry();
  let runs = registry.runs;

  if (filter?.repoPath) {
    runs = runs.filter((r) => r.repoPath === filter.repoPath);
  }
  if (filter?.status) {
    runs = runs.filter((r) => r.status === filter.status);
  }

  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
