// Automation registry - persistent tracking of automation runs and work items (SQLite-backed)
import { getDb } from "./db.js";

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

// DB row types
interface RunRow {
  id: string;
  automation_id: string;
  automation_name: string;
  repo_path: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  producer_task_id: string | null;
  producer_worktree_path: string | null;
}

interface WorkItemRow {
  id: string;
  run_id: string;
  prompt: string;
  status: string;
  task_id: string | null;
  worktree_path: string | null;
}

function rowToRun(row: RunRow, items: WorkItem[]): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    repoPath: row.repo_path,
    status: row.status as AutomationRunStatus,
    startedAt: new Date(row.started_at).toISOString(),
    endedAt: row.ended_at != null ? new Date(row.ended_at).toISOString() : undefined,
    producerTaskId: row.producer_task_id ?? undefined,
    producerWorktreePath: row.producer_worktree_path ?? undefined,
    workItems: items,
  };
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status as WorkItemStatus,
    taskId: row.task_id ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
  };
}

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

function getWorkItemsForRun(runId: string): WorkItem[] {
  const rows = getDb().prepare<[string], WorkItemRow>(
    "SELECT * FROM work_items WHERE run_id = ?"
  ).all(runId);
  return rows.map(rowToWorkItem);
}

export async function createRun(
  fields: Omit<AutomationRun, "id" | "startedAt" | "workItems">
): Promise<AutomationRun> {
  const db = getDb();
  const id = generateId("auto");
  const now = Date.now();

  db.prepare(`
    INSERT INTO automation_runs (id, automation_id, automation_name, repo_path, status, started_at, ended_at, producer_task_id, producer_worktree_path)
    VALUES (@id, @automation_id, @automation_name, @repo_path, @status, @started_at, @ended_at, @producer_task_id, @producer_worktree_path)
  `).run({
    id,
    automation_id: fields.automationId,
    automation_name: fields.automationName,
    repo_path: fields.repoPath,
    status: fields.status,
    started_at: now,
    ended_at: null,
    producer_task_id: fields.producerTaskId ?? null,
    producer_worktree_path: fields.producerWorktreePath ?? null,
  });

  return {
    id,
    startedAt: new Date(now).toISOString(),
    workItems: [],
    ...fields,
  };
}

export async function updateRun(
  id: string,
  updates: Partial<Pick<AutomationRun, "status" | "endedAt" | "producerTaskId" | "producerWorktreePath">>
): Promise<void> {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.producerTaskId !== undefined) {
    sets.push("producer_task_id = ?");
    params.push(updates.producerTaskId);
  }
  if (updates.producerWorktreePath !== undefined) {
    sets.push("producer_worktree_path = ?");
    params.push(updates.producerWorktreePath);
  }

  // Auto-set endedAt for terminal statuses
  if (updates.endedAt !== undefined) {
    sets.push("ended_at = ?");
    params.push(new Date(updates.endedAt).getTime());
  } else if (updates.status && updates.status !== "producing" && updates.status !== "running") {
    sets.push("ended_at = COALESCE(ended_at, ?)");
    params.push(Date.now());
  }

  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE automation_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export async function addWorkItems(
  runId: string,
  prompts: string[]
): Promise<WorkItem[]> {
  const db = getDb();

  // Verify run exists
  const run = db.prepare("SELECT id FROM automation_runs WHERE id = ?").get(runId);
  if (!run) return [];

  const items: WorkItem[] = prompts.map((prompt) => ({
    id: generateId("wi"),
    prompt,
    status: "pending" as const,
  }));

  const insert = db.prepare(`
    INSERT INTO work_items (id, run_id, prompt, status)
    VALUES (?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const item of items) {
      insert.run(item.id, runId, item.prompt, item.status);
    }
  })();

  return items;
}

export async function updateWorkItem(
  runId: string,
  workItemId: string,
  updates: Partial<Pick<WorkItem, "status" | "taskId" | "worktreePath">>
): Promise<void> {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);
  }
  if (updates.taskId !== undefined) {
    sets.push("task_id = ?");
    params.push(updates.taskId);
  }
  if (updates.worktreePath !== undefined) {
    sets.push("worktree_path = ?");
    params.push(updates.worktreePath);
  }

  if (sets.length === 0) return;

  params.push(workItemId, runId);
  db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ? AND run_id = ?`).run(...params);
}

export async function getRun(id: string): Promise<AutomationRun | null> {
  const row = getDb().prepare<[string], RunRow>(
    "SELECT * FROM automation_runs WHERE id = ?"
  ).get(id);
  if (!row) return null;
  return rowToRun(row, getWorkItemsForRun(id));
}

export async function listRuns(filter?: {
  repoPath?: string;
  status?: AutomationRunStatus;
}): Promise<AutomationRun[]> {
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
  const rows = db.prepare<unknown[], RunRow>(
    `SELECT * FROM automation_runs ${where} ORDER BY started_at DESC`
  ).all(...params);

  return rows.map((row) => rowToRun(row, getWorkItemsForRun(row.id)));
}
