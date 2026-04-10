/**
 * Singleton SQLite database for many.
 * WAL mode, foreign keys ON.
 * All registries (tasks, automations, notes, etc.) will live here.
 *
 * Pattern: typed query functions exported from this module.
 * Handlers call db.functionName() - no inline SQL in handlers.
 */

import Database from "better-sqlite3";
import path from "path";
import { readFileSync } from "fs";
import { getDataPath } from "./config.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.join(getDataPath(), "many.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
  migrateJsonData(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_notes (
      repo_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      notes TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo_path, branch)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      pool_prefix TEXT NOT NULL,
      pool_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      prompt TEXT NOT NULL,
      task_command TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','unknown')),
      exit_code INTEGER,
      log_file TEXT,
      launched_by TEXT NOT NULL CHECK(launched_by IN ('cli','web'))
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      automation_name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('producing','running','completed','failed','cancelled')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      producer_task_id TEXT REFERENCES tasks(id),
      producer_worktree_path TEXT
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      task_id TEXT REFERENCES tasks(id),
      worktree_path TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_path);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_path);
    CREATE INDEX IF NOT EXISTS idx_runs_repo ON automation_runs(repo_path);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON automation_runs(status);
    CREATE INDEX IF NOT EXISTS idx_work_items_run ON work_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
    CREATE INDEX IF NOT EXISTS idx_work_items_task ON work_items(task_id);
  `);
}

function isoToEpoch(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

function migrateJsonData(db: Database.Database): void {
  const dataPath = getDataPath();

  // Migrate tasks from task-registry.json
  const taskCount = (db.prepare("SELECT COUNT(*) as c FROM tasks").get() as { c: number }).c;
  if (taskCount === 0) {
    try {
      const raw = readFileSync(path.join(dataPath, "task-registry.json"), "utf-8");
      const tasks: any[] = (JSON.parse(raw).tasks || []);
      if (tasks.length > 0) {
        const insert = db.prepare(`
          INSERT INTO tasks (id, pid, repo_path, worktree_path, pool_prefix, pool_name, branch, prompt, task_command, started_at, ended_at, status, exit_code, log_file, launched_by)
          VALUES (@id, @pid, @repo_path, @worktree_path, @pool_prefix, @pool_name, @branch, @prompt, @task_command, @started_at, @ended_at, @status, @exit_code, @log_file, @launched_by)
        `);
        db.transaction((rows: any[]) => {
          for (const t of rows) {
            insert.run({
              id: t.id,
              pid: t.pid,
              repo_path: t.repoPath,
              worktree_path: t.worktreePath,
              pool_prefix: t.poolPrefix,
              pool_name: t.poolName,
              branch: t.branch,
              prompt: t.prompt,
              task_command: t.taskCommand,
              started_at: isoToEpoch(t.startedAt) ?? Date.now(),
              ended_at: isoToEpoch(t.endedAt),
              status: t.status,
              exit_code: t.exitCode ?? null,
              log_file: t.logFile ?? null,
              launched_by: t.launchedBy,
            });
          }
        })(tasks);
      }
    } catch {
      // No JSON file or parse error - nothing to migrate
    }
  }

  // Migrate automation runs + work items from automation-registry.json
  const runCount = (db.prepare("SELECT COUNT(*) as c FROM automation_runs").get() as { c: number }).c;
  if (runCount === 0) {
    try {
      const raw = readFileSync(path.join(dataPath, "automation-registry.json"), "utf-8");
      const runs: any[] = (JSON.parse(raw).runs || []);
      if (runs.length > 0) {
        const insertRun = db.prepare(`
          INSERT INTO automation_runs (id, automation_id, automation_name, repo_path, status, started_at, ended_at, producer_task_id, producer_worktree_path)
          VALUES (@id, @automation_id, @automation_name, @repo_path, @status, @started_at, @ended_at, @producer_task_id, @producer_worktree_path)
        `);
        const insertItem = db.prepare(`
          INSERT INTO work_items (id, run_id, prompt, status, task_id, worktree_path)
          VALUES (@id, @run_id, @prompt, @status, @task_id, @worktree_path)
        `);
        db.transaction((rows: any[]) => {
          for (const r of rows) {
            insertRun.run({
              id: r.id,
              automation_id: r.automationId,
              automation_name: r.automationName,
              repo_path: r.repoPath,
              status: r.status,
              started_at: isoToEpoch(r.startedAt) ?? Date.now(),
              ended_at: isoToEpoch(r.endedAt),
              producer_task_id: r.producerTaskId ?? null,
              producer_worktree_path: r.producerWorktreePath ?? null,
            });
            for (const wi of (r.workItems || [])) {
              insertItem.run({
                id: wi.id,
                run_id: r.id,
                prompt: wi.prompt,
                status: wi.status,
                task_id: wi.taskId ?? null,
                worktree_path: wi.worktreePath ?? null,
              });
            }
          }
        })(runs);
      }
    } catch {
      // No JSON file or parse error - nothing to migrate
    }
  }
}

// ---------------------------------------------------------------------------
// Branch notes
// ---------------------------------------------------------------------------

export function getBranchNotes(repoPath: string, branch: string): string {
  const row = getDb()
    .prepare<[string, string], { notes: string }>(
      "SELECT notes FROM branch_notes WHERE repo_path = ? AND branch = ?"
    )
    .get(repoPath, branch);
  return row?.notes ?? "";
}

export function setBranchNotes(repoPath: string, branch: string, notes: string): void {
  const db = getDb();
  if (notes) {
    db.prepare(
      `INSERT INTO branch_notes (repo_path, branch, notes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_path, branch) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at`
    ).run(repoPath, branch, notes, Date.now());
  } else {
    db.prepare("DELETE FROM branch_notes WHERE repo_path = ? AND branch = ?").run(repoPath, branch);
  }
}
