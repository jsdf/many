// Shared git operations used by both the Electron main process and the CLI
import { simpleGit } from "simple-git";
import path from "path";
import { promises as fs } from "fs";
import logger from "./logger.js";

// --- Types ---

export interface ParsedWorktree {
  path: string;
  commit?: string;
  branch?: string;
  bare?: boolean;
  locked?: boolean;
}

export interface GitStatus {
  modified: string[];
  not_added: string[];
  deleted: string[];
  created: string[];
  staged: string[];
  hasChanges: boolean;
  hasStaged: boolean;
  truncated?: boolean;
  totalFiles?: number;
}

export const GIT_STATUS_MAX_FILES = 500;

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

/** Check that a worktree directory exists on disk, throwing a clear error if not */
async function ensureWorktreeExists(worktreePath: string): Promise<void> {
  try {
    await fs.access(worktreePath);
  } catch {
    throw new Error(
      `Worktree directory does not exist: ${worktreePath}\n` +
      `It may have been manually deleted. The worktree list will be refreshed automatically.`
    );
  }
}

/** Parse `git worktree list --porcelain` output into structured data */
export async function parseWorktreeList(
  repoPath: string
): Promise<ParsedWorktree[]> {
  const git = simpleGit(repoPath);

  // Unlock stale locked worktrees (directories that no longer exist) so prune can remove them
  await unlockStaleWorktrees(repoPath);

  // Prune stale worktree entries (e.g. directories manually deleted)
  await git.raw(["worktree", "prune"]);

  const output = await git.raw(["worktree", "list", "--porcelain"]);

  return parseWorktreeListOutput(output);
}

/** Parse porcelain output from `git worktree list --porcelain` */
export function parseWorktreeListOutput(output: string): ParsedWorktree[] {
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
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    }
  }
  if (current.path) parsed.push(current as ParsedWorktree);

  return parsed;
}

/**
 * Find locked worktrees whose directories no longer exist and unlock them
 * so that `git worktree prune` can clean them up.
 */
async function unlockStaleWorktrees(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath);

  let output: string;
  try {
    output = await git.raw(["worktree", "list", "--porcelain"]);
  } catch {
    return;
  }

  const worktrees = parseWorktreeListOutput(output);

  for (const wt of worktrees) {
    if (!wt.locked || wt.bare) continue;

    let exists = true;
    try {
      await fs.access(wt.path);
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        await git.raw(["worktree", "unlock", wt.path]);
        logger.info(`Auto-unlocked stale worktree: ${wt.path}`);
      } catch {
        // May fail if already unlocked or other issue - prune will handle what it can
      }
    }
  }
}

/**
 * Read the worktree list directly from the filesystem, no git process needed.
 * Reads .git/HEAD for the main worktree and .git/worktrees/<name>/{HEAD,gitdir}
 * for linked worktrees. Suitable for lightweight polling/subscription updates.
 */
export async function readWorktreeListFromFS(
  repoPath: string
): Promise<ParsedWorktree[]> {
  const gitDir = path.join(repoPath, ".git");
  const result: ParsedWorktree[] = [];

  // Main worktree
  const mainHead = await readHeadFile(path.join(gitDir, "HEAD"));
  if (mainHead) {
    result.push({
      path: repoPath,
      branch: mainHead.branch ?? undefined,
      commit: mainHead.commit ??
        (mainHead.branch
          ? await resolveRef(gitDir, mainHead.branch)
          : undefined),
    });
  }

  // Linked worktrees
  const worktreesDir = path.join(gitDir, "worktrees");
  let entries: string[];
  try {
    entries = await fs.readdir(worktreesDir);
  } catch {
    return result; // No linked worktrees
  }

  for (const entry of entries) {
    const wtDir = path.join(worktreesDir, entry);
    const head = await readHeadFile(path.join(wtDir, "HEAD"));
    if (!head) continue;

    // gitdir file contains the path to the worktree's .git file
    const wtPath = await readWorktreePath(path.join(wtDir, "gitdir"));
    if (!wtPath) continue;

    result.push({
      path: wtPath,
      branch: head.branch ?? undefined,
      commit: head.commit ??
        (head.branch ? await resolveRef(gitDir, head.branch) : undefined),
    });
  }

  return result;
}

/** Read a HEAD file and parse it into a branch ref or detached commit */
async function readHeadFile(
  headPath: string
): Promise<{ branch: string | null; commit: string | null } | null> {
  try {
    const content = (await fs.readFile(headPath, "utf-8")).trim();
    if (content.startsWith("ref: ")) {
      return { branch: content.substring(5), commit: null };
    }
    // Detached HEAD — content is a commit SHA
    if (/^[0-9a-f]{40}$/.test(content)) {
      return { branch: null, commit: content };
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve a ref (e.g. refs/heads/main) to a commit SHA via the filesystem */
async function resolveRef(
  gitDir: string,
  ref: string
): Promise<string | undefined> {
  // Try loose ref first
  try {
    const content = (await fs.readFile(path.join(gitDir, ref), "utf-8")).trim();
    if (/^[0-9a-f]{40}$/.test(content)) return content;
  } catch {
    // Fall through to packed-refs
  }

  // Try packed-refs
  try {
    const packed = await fs.readFile(
      path.join(gitDir, "packed-refs"),
      "utf-8"
    );
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, packedRef] = line.split(" ", 2);
      if (packedRef === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  } catch {
    // No packed-refs file
  }

  return undefined;
}

/** Read a worktree's gitdir file to get its working directory path */
async function readWorktreePath(
  gitdirPath: string
): Promise<string | null> {
  try {
    // gitdir contains path to the worktree's .git file, e.g. /path/to/worktree/.git
    const content = (await fs.readFile(gitdirPath, "utf-8")).trim();
    return path.dirname(content);
  } catch {
    return null;
  }
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
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);

  // Use raw porcelain output without -u flag. simple-git's status() passes -u
  // which expands untracked directories into individual files, causing
  // extremely slow enumeration on large repos with many untracked files.
  // Without -u, git collapses untracked directories into single entries.
  const raw = await git.raw(["status", "--porcelain", "-b"]);

  const staged: string[] = [];
  const modified: string[] = [];
  const not_added: string[] = [];
  const deleted: string[] = [];
  const created: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("##")) continue;
    const x = line[0]; // index (staged) status
    const y = line[1]; // worktree status
    const file = line.slice(3);

    if (x === "?" && y === "?") {
      not_added.push(file);
    } else {
      if (x === "A") staged.push(file);
      else if (x === "M") staged.push(file);
      else if (x === "D") staged.push(file);
      else if (x === "R") staged.push(file);

      if (y === "M") modified.push(file);
      else if (y === "D") deleted.push(file);
      else if (y === "A") created.push(file);
    }
  }

  const totalFiles =
    modified.length + not_added.length + deleted.length + created.length + staged.length;
  const truncated = totalFiles > GIT_STATUS_MAX_FILES;

  const truncate = (arr: string[], remaining: number) => {
    const sliced = arr.slice(0, remaining);
    return { result: sliced, used: sliced.length };
  };

  let finalStaged = staged;
  let finalModified = modified;
  let finalNotAdded = not_added;
  let finalDeleted = deleted;
  let finalCreated = created;

  if (truncated) {
    let remaining = GIT_STATUS_MAX_FILES;
    ({ result: finalStaged } = truncate(staged, remaining));
    remaining -= finalStaged.length;
    ({ result: finalModified } = truncate(modified, remaining));
    remaining -= finalModified.length;
    ({ result: finalNotAdded } = truncate(not_added, remaining));
    remaining -= finalNotAdded.length;
    ({ result: finalDeleted } = truncate(deleted, remaining));
    remaining -= finalDeleted.length;
    ({ result: finalCreated } = truncate(created, remaining));
  }

  return {
    modified: finalModified,
    not_added: finalNotAdded,
    deleted: finalDeleted,
    created: finalCreated,
    staged: finalStaged,
    hasChanges:
      modified.length > 0 ||
      not_added.length > 0 ||
      deleted.length > 0 ||
      created.length > 0,
    hasStaged: staged.length > 0,
    truncated,
    totalFiles,
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
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);
  const stashMessage =
    message || `Stash from release at ${new Date().toISOString()}`;
  await git.stash(["push", "-m", stashMessage, "--include-untracked"]);
}

/** Clean all changes (discard modified + delete untracked) */
export async function cleanChanges(worktreePath: string): Promise<void> {
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);
  await git.reset(["--hard", "HEAD"]);
  await git.clean("fd");
}

/** Amend changes to the last commit */
export async function amendChanges(worktreePath: string, options?: { noVerify?: boolean }): Promise<void> {
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);
  await git.add("-A");
  const commitOpts: Record<string, null> = { "--amend": null, "--no-edit": null };
  if (options?.noVerify) commitOpts["--no-verify"] = null;
  await git.commit([], commitOpts);
}

/** Commit changes with a message */
export async function commitChanges(
  worktreePath: string,
  message: string,
  options?: { noVerify?: boolean }
): Promise<void> {
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);
  await git.add("-A");
  if (options?.noVerify) {
    await git.commit(message, { "--no-verify": null });
  } else {
    await git.commit(message);
  }
}

/**
 * Claim a worktree for a branch (checkout existing or create new).
 * When pullLatest is true (default), fetches from origin and resets to the remote version.
 * Returns the branch name that was checked out.
 */
export async function claimWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  mainBranch: string | null,
  pullLatest: boolean = true
): Promise<string> {
  await ensureWorktreeExists(worktreePath);
  const git = simpleGit(worktreePath);
  const repoGit = simpleGit(repoPath);

  // Fetch from remote if pulling latest
  if (pullLatest) {
    try {
      await repoGit.fetch("origin", branchName);
    } catch {
      // Ignore fetch errors (might be offline or branch doesn't exist on remote)
    }
  }

  const branches = await repoGit.branch();
  const localExists = branches.all.includes(branchName) && !branchName.startsWith("remotes/");
  const remoteRef = `remotes/origin/${branchName}`;
  const remoteExists = branches.all.includes(remoteRef);

  if (localExists) {
    await git.raw(["checkout", "--no-recurse-submodules", branchName]);
    // Update from remote if pulling latest and remote exists
    if (pullLatest && remoteExists) {
      try {
        await git.raw(["reset", "--hard", `origin/${branchName}`]);
      } catch {
        // Ignore — remote may be stale or diverged
      }
    }
  } else if (remoteExists) {
    // Create local branch tracking the remote
    await git.raw(["checkout", "--no-recurse-submodules", "-b", branchName, `origin/${branchName}`]);
  } else {
    // Brand new branch — base on default branch
    const defaultBranch = await getDefaultBranch(repoPath, mainBranch);

    if (pullLatest) {
      try {
        await repoGit.fetch("origin", defaultBranch);
      } catch {
        // Ignore fetch errors (might be offline)
      }
    }

    await git.raw(["checkout", "--no-recurse-submodules", "-b", branchName, defaultBranch]);
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
  mainBranch: string | null,
  force: boolean = false
): Promise<{ tmpBranch: string; previousBranch: string }> {
  await ensureWorktreeExists(worktreePath);
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

  if (force) {
    // Bypass checkout entirely — create/move the branch and update HEAD directly.
    // This avoids submodule update errors that block normal git switch.
    await git.raw(["branch", "-f", tmpBranchName, targetCommit]);
    await git.raw(["symbolic-ref", "HEAD", `refs/heads/${tmpBranchName}`]);
  } else {
    await git.raw(["switch", "--force-create", tmpBranchName, targetCommit]);
  }

  return { tmpBranch: tmpBranchName, previousBranch };
}
