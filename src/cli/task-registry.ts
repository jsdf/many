// Task registry - persistent tracking of spawned task processes
import { promises as fs, constants as fsConstants } from "fs";
import { open } from "fs/promises";
import path from "path";
import { getDataPath } from "./config.js";

export type TaskStatus = "running" | "completed" | "failed" | "unknown";

export interface TaskRecord {
  id: string;
  pid: number;
  repoPath: string;
  worktreePath: string;
  poolPrefix: string;
  poolName: string;
  branch: string;
  prompt: string;
  taskCommand: string;
  startedAt: string;
  endedAt?: string;
  status: TaskStatus;
  exitCode?: number;
  logFile?: string;
  launchedBy: "cli" | "web";
}

interface TaskRegistryData {
  tasks: TaskRecord[];
}

const defaultRegistryData: TaskRegistryData = { tasks: [] };

function getRegistryFilePath(): string {
  return path.join(getDataPath(), "task-registry.json");
}

export function getTaskLogDir(): string {
  return path.join(getDataPath(), "task-logs");
}

export async function loadRegistry(): Promise<TaskRegistryData> {
  const filePath = getRegistryFilePath();
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return { ...defaultRegistryData, ...JSON.parse(data) };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      return defaultRegistryData;
    }
    throw new Error(`Failed to load task registry: ${error instanceof Error ? error.message : error}`);
  }
}

async function saveRegistry(data: TaskRegistryData): Promise<void> {
  const filePath = getRegistryFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, filePath);
}

// File-based locking to prevent concurrent read-modify-write races.
// Uses O_EXCL to atomically create a lockfile; retries with backoff.
const LOCK_STALE_MS = 10_000; // consider lock stale after 10s (crashed process)

async function acquireLock(): Promise<void> {
  const lockPath = getRegistryFilePath() + ".lock";
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if file exists
      const fh = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
      // Write our PID so stale locks can be detected
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Lock file exists — check if it's stale
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Stale lock — remove and retry immediately
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Lock file disappeared between our check — retry
        continue;
      }

      // Wait with jittered backoff
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }

  // Last resort: force remove potentially stuck lock
  await fs.unlink(getRegistryFilePath() + ".lock").catch(() => {});
  throw new Error("Failed to acquire task registry lock after max attempts");
}

async function releaseLock(): Promise<void> {
  await fs.unlink(getRegistryFilePath() + ".lock").catch(() => {});
}

// Run a read-modify-write operation under the file lock
async function withRegistry<T>(fn: (registry: TaskRegistryData) => Promise<{ result: T; save: boolean }>): Promise<T> {
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

function generateTaskId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `task-${ts}-${rand}`;
}

export function isProcessAlive(pid: number): boolean {
  // pid <= 0 is invalid: 0 means "current process group", negative means
  // "process group abs(pid)".  Sending signals to these would affect the
  // server itself, so treat them as "not alive".
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means process exists but we don't have permission (still alive)
    if (err.code === "EPERM") return true;
    // ESRCH means no such process
    return false;
  }
}

export async function reconcileTasks(): Promise<void> {
  await withRegistry(async (registry) => {
    let changed = false;
    for (const task of registry.tasks) {
      if (task.status === "running") {
        if (!isProcessAlive(task.pid)) {
          task.status = "unknown";
          task.endedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    return { result: undefined, save: changed };
  });
}

export async function registerTask(
  fields: Omit<TaskRecord, "id" | "status" | "startedAt">
): Promise<TaskRecord> {
  return withRegistry(async (registry) => {
    const task: TaskRecord = {
      id: generateTaskId(),
      status: "running",
      startedAt: new Date().toISOString(),
      ...fields,
    };
    registry.tasks.push(task);
    return { result: task, save: true };
  });
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  exitCode?: number
): Promise<void> {
  await withRegistry(async (registry) => {
    const task = registry.tasks.find((t) => t.id === id);
    if (!task) return { result: undefined, save: false };

    task.status = status;
    if (exitCode !== undefined) task.exitCode = exitCode;
    if (status !== "running") task.endedAt = new Date().toISOString();
    return { result: undefined, save: true };
  });
}

export async function updateTaskPid(id: string, pid: number): Promise<void> {
  await withRegistry(async (registry) => {
    const task = registry.tasks.find((t) => t.id === id);
    if (!task) return { result: undefined, save: false };
    task.pid = pid;
    return { result: undefined, save: true };
  });
}

export async function markTaskCompleted(id: string, exitCode: number): Promise<void> {
  await updateTaskStatus(id, exitCode === 0 ? "completed" : "failed", exitCode);
}

export async function listTasks(filter?: {
  repoPath?: string;
  status?: TaskStatus;
}): Promise<TaskRecord[]> {
  // Read-only — no lock needed
  const registry = await loadRegistry();
  let tasks = registry.tasks;

  if (filter?.repoPath) {
    tasks = tasks.filter((t) => t.repoPath === filter.repoPath);
  }
  if (filter?.status) {
    tasks = tasks.filter((t) => t.status === filter.status);
  }

  return tasks.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  // Read-only — no lock needed
  const registry = await loadRegistry();
  return registry.tasks.find((t) => t.id === id) || null;
}

export async function killTask(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
  const task = await getTask(id);
  if (!task || task.status !== "running") return false;

  if (!isProcessAlive(task.pid)) {
    await updateTaskStatus(id, "unknown");
    return false;
  }

  try {
    process.kill(task.pid, signal);
    // Give it a moment, then check and update
    await new Promise((r) => setTimeout(r, 500));
    if (!isProcessAlive(task.pid)) {
      await markTaskCompleted(id, 128 + 15); // SIGTERM = 15
    }
    return true;
  } catch {
    return false;
  }
}

export async function pruneOldTasks(maxAgeDays: number = 30): Promise<number> {
  return withRegistry(async (registry) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = registry.tasks.length;

    registry.tasks = registry.tasks.filter((t) => {
      if (t.status === "running") return true;
      const ended = t.endedAt ? new Date(t.endedAt).getTime() : new Date(t.startedAt).getTime();
      return ended > cutoff;
    });

    const removed = before - registry.tasks.length;
    return { result: removed, save: removed > 0 };
  });
}
