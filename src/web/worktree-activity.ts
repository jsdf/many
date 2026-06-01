import { simpleGit } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function encodeProjectPath(dirPath: string): string {
  return dirPath.replace(/\//g, "-");
}

/** Newest .jsonl mtime (ms) in the worktree's Claude projects dir, or 0 if none. */
async function getLatestClaudeActivity(worktreePath: string): Promise<number> {
  const projectDir = path.join(getClaudeProjectsDir(), encodeProjectPath(worktreePath));
  let files: string[];
  try {
    files = await fs.promises.readdir(projectDir);
  } catch {
    return 0;
  }
  let latest = 0;
  for (const f of files) {
    if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
    try {
      const stat = await fs.promises.stat(path.join(projectDir, f));
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch {
      // file gone between readdir and stat — ignore
    }
  }
  return latest;
}

/** Committer date (ms) keyed by short branch name, for all local branches. One git call. */
async function getBranchCommitTimes(repoPath: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const git = simpleGit(repoPath);
    const out = await git.raw([
      "for-each-ref",
      "--format=%(refname:short)%09%(committerdate:unix)",
      "refs/heads",
    ]);
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [name, unix] = line.split("\t");
      const secs = Number(unix);
      if (name && Number.isFinite(secs)) result.set(name, secs * 1000);
    }
  } catch {
    // not a git repo / git unavailable — return whatever we have
  }
  return result;
}

/**
 * Compute the most recent activity timestamp (ms) per worktree, defined as the
 * later of the worktree's last Claude session write and its branch's last commit.
 * Worktrees with no detectable activity are omitted.
 */
export async function computeWorktreeActivityTimes(
  repoPath: string,
  worktrees: { path: string; branch: string | null }[]
): Promise<Record<string, number>> {
  const branchTimes = await getBranchCommitTimes(repoPath);
  const result: Record<string, number> = {};
  await Promise.all(
    worktrees.map(async (wt) => {
      const shortBranch = wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : null;
      const gitTime = shortBranch ? branchTimes.get(shortBranch) ?? 0 : 0;
      const claudeTime = await getLatestClaudeActivity(wt.path);
      const latest = Math.max(gitTime, claudeTime);
      if (latest > 0) result[wt.path] = latest;
    })
  );
  return result;
}
