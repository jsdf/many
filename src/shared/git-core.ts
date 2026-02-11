// Shared git operations used by both the Electron main process and the CLI
import { simpleGit } from "simple-git";
import path from "path";
import { promises as fs } from "fs";

// --- Types ---

export interface ParsedWorktree {
  path: string;
  commit?: string;
  branch?: string;
  bare?: boolean;
}

export interface GitStatus {
  modified: string[];
  not_added: string[];
  deleted: string[];
  created: string[];
  staged: string[];
  hasChanges: boolean;
  hasStaged: boolean;
}

// --- Constants ---

export const TMP_BRANCH_PREFIX = "tmp-";

// --- Utilities ---

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extractWorktreeName(
  worktreePath: string,
  repoPath: string
): string {
  const baseName = path.basename(repoPath);
  const worktreeDirName = path.basename(worktreePath);

  if (worktreeDirName.startsWith(baseName + "-")) {
    return worktreeDirName.substring(baseName.length + 1);
  }
  return worktreeDirName;
}

export function isTmpBranch(branchName: string | null | undefined): boolean {
  if (!branchName) return false;
  const localBranch = branchName.replace(/^refs\/heads\//, "");
  return localBranch.startsWith(TMP_BRANCH_PREFIX);
}

export function getLocalBranchName(branch: string | null): string {
  if (!branch) return "(detached)";
  return branch.replace(/^refs\/heads\//, "");
}

// --- Core git operations ---

/** Parse `git worktree list --porcelain` output into structured data */
export async function parseWorktreeList(
  repoPath: string
): Promise<ParsedWorktree[]> {
  const git = simpleGit(repoPath);
  const output = await git.raw(["worktree", "list", "--porcelain"]);

  const parsed: ParsedWorktree[] = [];
  const lines = output.split("\n");
  let current: Partial<ParsedWorktree> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current.path) parsed.push(current as ParsedWorktree);
      current = { path: line.substring(9) };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.substring(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.substring(7);
    } else if (line.startsWith("bare")) {
      current.bare = true;
    }
  }
  if (current.path) parsed.push(current as ParsedWorktree);

  return parsed;
}

/** Get the default/main branch for a repo */
export async function getDefaultBranch(
  repoPath: string,
  mainBranch: string | null
): Promise<string> {
  if (mainBranch) {
    return mainBranch;
  }

  const git = simpleGit(repoPath);

  try {
    const remoteResult = await git.raw([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    return remoteResult.trim().replace("refs/remotes/origin/", "");
  } catch {
    const branches = await git.branch();
    if (branches.all.includes("main")) return "main";
    if (branches.all.includes("master")) return "master";
    if (branches.all.includes("develop")) return "develop";
    return branches.current || "main";
  }
}

/** Check if a branch exists in the repo */
export async function branchExists(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  const git = simpleGit(repoPath);
  const branches = await git.branch();
  return branches.all.includes(branchName);
}

/** Get git status for a worktree */
export async function getWorktreeStatus(
  worktreePath: string
): Promise<GitStatus> {
  const git = simpleGit(worktreePath);
  const status = await git.status();

  return {
    modified: status.modified,
    not_added: status.not_added,
    deleted: status.deleted,
    created: status.created,
    staged: status.staged,
    hasChanges:
      status.modified.length > 0 ||
      status.not_added.length > 0 ||
      status.deleted.length > 0 ||
      status.created.length > 0,
    hasStaged: status.staged.length > 0,
  };
}

/** Check if a branch is fully merged into the main branch */
export async function checkBranchMerged(
  repoPath: string,
  branchName: string,
  mainBranch: string | null
): Promise<{ isFullyMerged: boolean; mainBranch: string; branchName: string }> {
  const resolvedMain = await getDefaultBranch(repoPath, mainBranch);

  const git = simpleGit(repoPath);
  const mergeBase = (
    await git.raw(["merge-base", branchName, resolvedMain])
  ).trim();
  const branchCommit = (await git.raw(["rev-parse", branchName])).trim();

  return {
    isFullyMerged: mergeBase === branchCommit,
    mainBranch: resolvedMain,
    branchName,
  };
}

/**
 * Remove a worktree directory and clean up git references.
 * Tries `git worktree remove --force` first, falls back to manual cleanup.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const git = simpleGit(repoPath);

  try {
    await git.raw(["worktree", "remove", "--force", worktreePath]);
  } catch {
    // If git worktree remove fails, manually delete and prune
    try {
      await fs.access(worktreePath);
      await fs.rm(worktreePath, { recursive: true, force: true });
      try {
        await git.raw(["worktree", "remove", worktreePath]);
      } catch {
        await git.raw(["worktree", "prune"]);
      }
    } catch {
      // Directory may already be gone, just prune
      try {
        await git.raw(["worktree", "prune"]);
      } catch {
        // ignore
      }
      // Final attempt to remove directory if it still exists
      try {
        await fs.access(worktreePath);
        await fs.rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Already gone
      }
    }
  }
}

/** Stash changes in a worktree */
export async function stashChanges(
  worktreePath: string,
  message?: string
): Promise<void> {
  const git = simpleGit(worktreePath);
  const stashMessage =
    message || `Stash from release at ${new Date().toISOString()}`;
  await git.stash(["push", "-m", stashMessage, "--include-untracked"]);
}

/** Clean all changes (discard modified + delete untracked) */
export async function cleanChanges(worktreePath: string): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.reset(["--hard", "HEAD"]);
  await git.clean("fd");
}

/** Amend changes to the last commit */
export async function amendChanges(worktreePath: string): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.add("-A");
  await git.commit([], { "--amend": null, "--no-edit": null });
}

/** Commit changes with a message */
export async function commitChanges(
  worktreePath: string,
  message: string
): Promise<void> {
  const git = simpleGit(worktreePath);
  await git.add("-A");
  await git.commit(message);
}

/**
 * Claim a worktree for a branch (checkout existing or create new).
 * Returns the branch name that was checked out.
 */
export async function claimWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  mainBranch: string | null
): Promise<string> {
  const git = simpleGit(worktreePath);
  const repoGit = simpleGit(repoPath);

  const exists = await branchExists(repoPath, branchName);

  if (exists) {
    await git.checkout(branchName);
  } else {
    const defaultBranch = await getDefaultBranch(repoPath, mainBranch);

    try {
      await repoGit.fetch("origin", defaultBranch);
    } catch {
      // Ignore fetch errors (might be offline)
    }

    await git.checkout(["-b", branchName, defaultBranch]);
  }

  return branchName;
}

/**
 * Release a worktree back to the pool by switching to a tmp branch.
 * Returns { tmpBranch, previousBranch }.
 */
export async function releaseWorktree(
  repoPath: string,
  worktreePath: string,
  mainBranch: string | null
): Promise<{ tmpBranch: string; previousBranch: string }> {
  const git = simpleGit(worktreePath);
  const repoGit = simpleGit(repoPath);

  // Get current branch
  const status = await git.status();
  const previousBranch = status.current || "unknown";

  // Generate tmp branch name based on worktree name
  const worktreeName = extractWorktreeName(worktreePath, repoPath);
  const tmpBranchName = `${TMP_BRANCH_PREFIX}${worktreeName}`;

  const defaultBranch = await getDefaultBranch(repoPath, mainBranch);

  try {
    await repoGit.fetch("origin", defaultBranch);
  } catch {
    // Ignore fetch errors
  }

  let targetCommit: string;
  try {
    targetCommit = (
      await repoGit.raw(["rev-parse", `origin/${defaultBranch}`])
    ).trim();
  } catch {
    targetCommit = (await repoGit.raw(["rev-parse", defaultBranch])).trim();
  }

  const tmpExists = await branchExists(repoPath, tmpBranchName);

  if (tmpExists) {
    await git.checkout(tmpBranchName);
    await git.reset(["--hard", targetCommit]);
  } else {
    await git.checkout(["-B", tmpBranchName, targetCommit]);
  }

  return { tmpBranch: tmpBranchName, previousBranch };
}
