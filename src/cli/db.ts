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
import { getDataPath } from "./config.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.join(getDataPath(), "many.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  initSchema(_db);
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
  `);
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
