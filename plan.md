# Plan: Migrate task/automation registries to SQLite

## Goal
Replace `automation-registry.json` and `task-registry.json` with a single SQLite database for better observability, traceability, and reliability. The `AutomationRun.workItems[]` nested array becomes a proper relational join between `automation_runs` and `work_items` tables, linked to `tasks` via foreign keys.

## New file: `src/cli/db.ts`

Singleton `getDb()` following the mux/watcher/talon pattern:
- `better-sqlite3` with WAL mode, foreign keys ON
- DB path: `path.join(getDataPath(), "many.db")`
- `CREATE TABLE IF NOT EXISTS` for schema (no separate migrations)
- Migrate existing JSON data on first open if tables are empty but JSON files exist

### Schema

```sql
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
```

Timestamps stored as epoch milliseconds (integers), matching mux/talon convention.

### JSON migration on first open
- If `tasks` table is empty and `task-registry.json` exists, bulk-insert existing records
- If `automation_runs` table is empty and `automation-registry.json` exists, bulk-insert runs and work items
- Convert ISO timestamp strings to epoch ms during migration
- One-time operation, runs inside a transaction

## Rewrite: `src/cli/task-registry.ts`

Replace all JSON file I/O and locking with SQLite queries via `getDb()`:
- Remove: `loadRegistry`, `saveRegistry`, `acquireLock`, `releaseLock`, `withRegistry`
- Keep the same exported function signatures (no caller changes needed)
- `registerTask` → `INSERT INTO tasks`
- `updateTaskStatus` → `UPDATE tasks SET status=?, exit_code=?, ended_at=? WHERE id=?`
- `updateTaskPid` → `UPDATE tasks SET pid=? WHERE id=?`
- `markTaskCompleted` → calls `updateTaskStatus` (unchanged)
- `listTasks` → `SELECT ... FROM tasks WHERE ... ORDER BY started_at DESC`
- `getTask` → `SELECT ... FROM tasks WHERE id=?`
- `killTask` → same logic, just uses SQL reads/writes
- `reconcileTasks` → `SELECT id, pid FROM tasks WHERE status='running'` then update dead ones
- `pruneOldTasks` → `DELETE FROM tasks WHERE status != 'running' AND ended_at < ?`
- `isProcessAlive`, `getTaskLogDir`, `generateTaskId` → unchanged

All functions remain async to preserve the existing API contract (callers all use `await`), even though better-sqlite3 is synchronous.

## Rewrite: `src/cli/automation-registry.ts`

Same approach - replace JSON with SQL:
- Remove: all locking/file I/O code
- `createRun` → `INSERT INTO automation_runs`
- `updateRun` → `UPDATE automation_runs SET ...`
- `addWorkItems` → `INSERT INTO work_items` (batch in transaction)
- `updateWorkItem` → `UPDATE work_items SET ... WHERE id=? AND run_id=?`
- `getRun` → `SELECT` from `automation_runs` + `SELECT` from `work_items WHERE run_id=?`, assemble into `AutomationRun` with `workItems[]` array
- `listRuns` → same join pattern, with optional `WHERE repo_path=?` / `WHERE status=?`

The `AutomationRun` interface keeps `workItems: WorkItem[]` — the join is internal. All callers see the same shape.

## Callers — no changes needed

All 8 call sites import the same function signatures:
- `automation-service.ts` → uses `createRun`, `updateRun`, `addWorkItems`, `updateWorkItem`, `getRun`
- `rpc-handlers.ts` → uses `listRuns`, `getRun`, `listTasks`, `killTask`, `getTask`, `registerTask`, `markTaskCompleted`, `reconcileTasks`
- `cli/index.ts` → uses `listTasks`, `getTask`, `killTask`, `pruneOldTasks`, `reconcileTasks`, `getTaskLogDir`
- `worktree-service.ts` → uses `registerTask`
- `web/server.ts` → uses `registerTask`, `markTaskCompleted`, `reconcileTasks`
- `task-step.ts` → uses `getTask`

Since function signatures don't change, these files need zero modifications.

## Setup steps

1. `npm install better-sqlite3 && npm install -D @types/better-sqlite3`
2. Add `better-sqlite3` to `electron-rebuild` script in package.json
3. Add `many.db` to `.gitignore`

## Implementation order

1. Install better-sqlite3, update package.json rebuild script
2. Create `src/cli/db.ts` with schema + JSON migration
3. Rewrite `src/cli/task-registry.ts` to use db
4. Rewrite `src/cli/automation-registry.ts` to use db
5. Build, run tests, verify existing tests pass
6. Manual test: start server, check task queue and automations views work
7. Commit

## What's NOT changing
- `app-data.json` stays as JSON (UI config, not task data)
- `AutomationDefinition` storage in `repositoryConfigs` stays in app-data.json (it's repo config, not run data)
- Task log files stay as files on disk
- All TypeScript interfaces/types remain the same
- All exported function signatures remain the same
