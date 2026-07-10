// Task registry - persistent tracking of spawned task processes (SQLite-backed)
import path from "path";
import { getDataPath } from "./config.js";
import { getDb } from "./db.js";

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
  recursiveMemoryBytes?: number;
  processCount?: number;
  logFile?: string;
  launchedBy: "cli" | "web";
}

// Map a DB row (snake_case, epoch ms) to a TaskRecord (camelCase, ISO string)
interface TaskRow {
  id: string;
  pid: number;
  repo_path: string;
  worktree_path: string;
  pool_prefix: string;
  pool_name: string;
  branch: string;
  prompt: string;
  task_command: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  exit_code: number | null;
  log_file: string | null;
  launched_by: string;
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    pid: row.pid,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    poolPrefix: row.pool_prefix,
    poolName: row.pool_name,
    branch: row.branch,
    prompt: row.prompt,
    taskCommand: row.task_command,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at != null ? new Date(row.ended_at).toISOString() : undefined,
    status: row.status as TaskStatus,
    exitCode: row.exit_code ?? undefined,
    logFile: row.log_file ?? undefined,
    launchedBy: row.launched_by as "cli" | "web",
  };
}

export function getTaskLogDir(): string {
  return path.join(getDataPath(), "task-logs");
}

export function getAgentLogDir(): string {
  return path.join(getDataPath(), "agent-logs");
}

export function getAgentTranscriptPath(agentId: string): string {
  return path.join(getAgentLogDir(), `${agentId}.ndjson`);
}

function generateTaskId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `task-${ts}-${rand}`;
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function reconcileTasks(): Promise<void> {
  const db = getDb();
  const running = db.prepare<[], Pick<TaskRow, "id" | "pid">>(
    "SELECT id, pid FROM tasks WHERE status = 'running'"
  ).all();

  const now = Date.now();
  const update = db.prepare("UPDATE tasks SET status = 'unknown', ended_at = ? WHERE id = ?");
  for (const row of running) {
    if (!isProcessAlive(row.pid)) {
      update.run(now, row.id);
    }
  }
}

export async function registerTask(
  fields: Omit<TaskRecord, "id" | "status" | "startedAt">
): Promise<TaskRecord> {
  const db = getDb();
  const id = generateTaskId();
  const now = Date.now();

  db.prepare(`
    INSERT INTO tasks (id, pid, repo_path, worktree_path, pool_prefix, pool_name, branch, prompt, task_command, started_at, status, log_file, launched_by)
    VALUES (@id, @pid, @repo_path, @worktree_path, @pool_prefix, @pool_name, @branch, @prompt, @task_command, @started_at, @status, @log_file, @launched_by)
  `).run({
    id,
    pid: fields.pid,
    repo_path: fields.repoPath,
    worktree_path: fields.worktreePath,
    pool_prefix: fields.poolPrefix,
    pool_name: fields.poolName,
    branch: fields.branch,
    prompt: fields.prompt,
    task_command: fields.taskCommand,
    started_at: now,
    status: "running",
    log_file: fields.logFile ?? null,
    launched_by: fields.launchedBy,
  });

  return {
    id,
    status: "running",
    startedAt: new Date(now).toISOString(),
    ...fields,
  };
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
  exitCode?: number
): Promise<void> {
  const db = getDb();
  const endedAt = status !== "running" ? Date.now() : null;
  db.prepare(
    "UPDATE tasks SET status = ?, exit_code = COALESCE(?, exit_code), ended_at = COALESCE(?, ended_at) WHERE id = ?"
  ).run(status, exitCode ?? null, endedAt, id);
}

export async function updateTaskPid(id: string, pid: number): Promise<void> {
  getDb().prepare("UPDATE tasks SET pid = ? WHERE id = ?").run(pid, id);
}

export async function markTaskCompleted(id: string, exitCode: number): Promise<void> {
  await updateTaskStatus(id, exitCode === 0 ? "completed" : "failed", exitCode);
}

export async function listTasks(filter?: {
  repoPath?: string;
  status?: TaskStatus;
}): Promise<TaskRecord[]> {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.repoPath) {
    conditions.push("repo_path = ?");
    params.push(filter.repoPath);
  }
  if (filter?.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare<unknown[], TaskRow>(
    `SELECT * FROM tasks ${where} ORDER BY started_at DESC`
  ).all(...params);

  return rows.map(rowToRecord);
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  const row = getDb().prepare<[string], TaskRow>(
    "SELECT * FROM tasks WHERE id = ?"
  ).get(id);
  return row ? rowToRecord(row) : null;
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
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const result = getDb().prepare(
    "DELETE FROM tasks WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?"
  ).run(cutoff);
  return result.changes;
}
