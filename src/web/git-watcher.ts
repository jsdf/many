// Watches git state files to detect branch changes across worktrees.
// Uses fs.watch (FSEvents on macOS) for efficient native file watching.

import { watch, FSWatcher } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { EventEmitter } from "events";

export interface GitWatcher extends EventEmitter {
  on(event: "changed", listener: (repoPath: string) => void): this;
  emit(event: "changed", repoPath: string): boolean;
}

export class RepoWatcher extends EventEmitter implements GitWatcher {
  private watchers = new Map<string, FSWatcher[]>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Start watching a repository and all its worktrees
  async watchRepo(repoPath: string): Promise<void> {
    if (this.watchers.has(repoPath)) return;

    const watchers: FSWatcher[] = [];
    const gitDir = path.join(repoPath, ".git");

    try {
      const gitDirStat = await stat(gitDir);

      if (gitDirStat.isDirectory()) {
        // Main repo — watch .git/HEAD for branch changes
        this.watchFile(path.join(gitDir, "HEAD"), repoPath, watchers);

        // Watch .git/worktrees/ directory for worktree additions/removals
        const worktreesDir = path.join(gitDir, "worktrees");
        try {
          await stat(worktreesDir);
          this.watchDir(worktreesDir, repoPath, watchers);

          // Watch each worktree's HEAD file
          const entries = await readdir(worktreesDir);
          for (const entry of entries) {
            const wtHeadPath = path.join(worktreesDir, entry, "HEAD");
            try {
              await stat(wtHeadPath);
              this.watchFile(wtHeadPath, repoPath, watchers);
            } catch {
              // No HEAD file — skip
            }
          }
        } catch {
          // No worktrees dir yet — that's fine
        }

        // Watch refs/heads for branch creation/deletion
        const refsDir = path.join(gitDir, "refs", "heads");
        try {
          await stat(refsDir);
          this.watchDir(refsDir, repoPath, watchers);
        } catch {
          // No refs/heads — unusual but ok
        }
      }
    } catch {
      // .git doesn't exist or isn't accessible — skip
      return;
    }

    this.watchers.set(repoPath, watchers);
  }

  // Stop watching a repository
  unwatchRepo(repoPath: string): void {
    const watchers = this.watchers.get(repoPath);
    if (watchers) {
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      this.watchers.delete(repoPath);
    }

    const timer = this.debounceTimers.get(repoPath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(repoPath);
    }
  }

  // Refresh watchers for a repo (e.g. when worktrees are added/removed)
  async refreshRepo(repoPath: string): Promise<void> {
    this.unwatchRepo(repoPath);
    await this.watchRepo(repoPath);
  }

  // Stop all watchers
  close(): void {
    for (const repoPath of this.watchers.keys()) {
      this.unwatchRepo(repoPath);
    }
  }

  private watchFile(filePath: string, repoPath: string, watchers: FSWatcher[]): void {
    try {
      const w = watch(filePath, () => this.debouncedEmit(repoPath));
      w.on("error", () => { /* ignore watch errors */ });
      watchers.push(w);
    } catch {
      // File may not exist — skip
    }
  }

  private watchDir(dirPath: string, repoPath: string, watchers: FSWatcher[]): void {
    try {
      const w = watch(dirPath, () => this.debouncedEmit(repoPath));
      w.on("error", () => { /* ignore watch errors */ });
      watchers.push(w);
    } catch {
      // Dir may not exist — skip
    }
  }

  // Debounce rapid changes (e.g. git operations touch multiple files)
  private debouncedEmit(repoPath: string): void {
    const existing = this.debounceTimers.get(repoPath);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      repoPath,
      setTimeout(() => {
        this.debounceTimers.delete(repoPath);
        this.emit("changed", repoPath);
      }, 300)
    );
  }
}
