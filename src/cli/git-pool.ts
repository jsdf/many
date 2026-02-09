// Git pool management - treating worktrees as a claimable pool
import { simpleGit } from "simple-git";
import path from "path";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { RepositoryConfig } from "./config.js";

const TMP_BRANCH_PREFIX = "tmp-";

export interface WorktreeInfo {
  path: string;
  commit: string;
  branch: string | null;
  bare: boolean;
  isAvailable: boolean; // true if on a tmp branch (available in pool)
  worktreeName: string; // extracted name from directory
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Extract worktree name from path
function extractWorktreeName(worktreePath: string, repoPath: string): string {
  const baseName = path.basename(repoPath);
  const worktreeDirName = path.basename(worktreePath);

  // If worktree dir starts with repo name + "-", extract the suffix
  if (worktreeDirName.startsWith(baseName + "-")) {
    return worktreeDirName.substring(baseName.length + 1);
  }
  return worktreeDirName;
}

// Check if a branch is a temporary pool branch
function isTmpBranch(branchName: string | null): boolean {
  if (!branchName) return false;
  // Extract local branch name from refs/heads/...
  const localBranch = branchName.replace(/^refs\/heads\//, "");
  return localBranch.startsWith(TMP_BRANCH_PREFIX);
}

// Get all worktrees with pool availability info
export async function getWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const git = simpleGit(repoPath);
    const worktrees = await git.raw(["worktree", "list", "--porcelain"]);

    const parsed: WorktreeInfo[] = [];
    const lines = worktrees.split("\n");
    let current: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          parsed.push(current as WorktreeInfo);
        }
        const worktreePath = line.substring(9);
        current = {
          path: worktreePath,
          bare: false,
          worktreeName: extractWorktreeName(worktreePath, repoPath),
        };
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.substring(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.substring(7);
      } else if (line.startsWith("bare")) {
        current.bare = true;
      }
    }
    if (current.path) {
      parsed.push(current as WorktreeInfo);
    }

    // Mark availability based on branch name
    return parsed.map((w) => ({
      ...w,
      isAvailable: isTmpBranch(w.branch),
    }));
  } catch (error) {
    throw new Error(`Failed to get worktrees: ${getErrorMessage(error)}`);
  }
}

// Get available worktrees (those on tmp branches)
export async function getAvailableWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const worktrees = await getWorktrees(repoPath);
  return worktrees.filter((w) => w.isAvailable && !w.bare);
}

// Get claimed worktrees (not on tmp branches and not bare)
export async function getClaimedWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const worktrees = await getWorktrees(repoPath);
  return worktrees.filter((w) => !w.isAvailable && !w.bare);
}

// Find a worktree by branch name or worktree name
export async function findWorktree(
  repoPath: string,
  identifier: string
): Promise<WorktreeInfo | null> {
  const worktrees = await getWorktrees(repoPath);

  // First try to match by branch name (without refs/heads/ prefix)
  const normalizedId = identifier.replace(/^refs\/heads\//, "");
  let match = worktrees.find((w) => {
    if (!w.branch) return false;
    const localBranch = w.branch.replace(/^refs\/heads\//, "");
    return localBranch === normalizedId;
  });

  if (match) return match;

  // Then try to match by worktree name
  match = worktrees.find((w) => w.worktreeName === identifier);

  return match || null;
}

// Get git status for a worktree
export async function getWorktreeStatus(worktreePath: string): Promise<GitStatus> {
  try {
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
  } catch (error) {
    throw new Error(`Failed to get worktree status: ${getErrorMessage(error)}`);
  }
}

// Get the main/default branch for a repo
export async function getDefaultBranch(
  repoPath: string,
  config: RepositoryConfig
): Promise<string> {
  if (config.mainBranch) {
    return config.mainBranch;
  }

  const git = simpleGit(repoPath);

  // Try to detect from remote
  try {
    const remoteResult = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return remoteResult.trim().replace("refs/remotes/origin/", "");
  } catch {
    // Fall back to common names
    const branches = await git.branch();
    if (branches.all.includes("main")) return "main";
    if (branches.all.includes("master")) return "master";
    if (branches.all.includes("develop")) return "develop";
    return branches.current || "main";
  }
}

// Check if a branch exists
export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  const git = simpleGit(repoPath);
  const branches = await git.branch();
  return branches.all.includes(branchName);
}

// Claim a worktree for a branch (switch command)
export async function claimWorktree(
  repoPath: string,
  worktree: WorktreeInfo,
  branchName: string,
  config: RepositoryConfig
): Promise<void> {
  const git = simpleGit(worktree.path);
  const repoGit = simpleGit(repoPath);

  // Check if branch exists
  const exists = await branchExists(repoPath, branchName);

  if (exists) {
    // Checkout existing branch
    await git.checkout(branchName);
  } else {
    // Create new branch from default branch HEAD
    const defaultBranch = await getDefaultBranch(repoPath, config);

    // Fetch latest from remote first (if possible)
    try {
      await repoGit.fetch("origin", defaultBranch);
    } catch {
      // Ignore fetch errors (might be offline)
    }

    // Create and checkout new branch from default branch
    await git.checkout(["-b", branchName, defaultBranch]);
  }
}

// Release a worktree - reset to tmp branch on default HEAD
export async function releaseWorktree(
  repoPath: string,
  worktree: WorktreeInfo,
  config: RepositoryConfig
): Promise<string> {
  const git = simpleGit(worktree.path);
  const repoGit = simpleGit(repoPath);

  // Generate tmp branch name based on worktree name
  const tmpBranchName = `${TMP_BRANCH_PREFIX}${worktree.worktreeName}`;

  // Get default branch and its HEAD
  const defaultBranch = await getDefaultBranch(repoPath, config);

  // Fetch latest from remote (if possible)
  try {
    await repoGit.fetch("origin", defaultBranch);
  } catch {
    // Ignore fetch errors
  }

  // Get the commit SHA for the default branch
  let targetCommit: string;
  try {
    targetCommit = (await repoGit.raw(["rev-parse", `origin/${defaultBranch}`])).trim();
  } catch {
    targetCommit = (await repoGit.raw(["rev-parse", defaultBranch])).trim();
  }

  // Check if tmp branch already exists
  const tmpExists = await branchExists(repoPath, tmpBranchName);

  if (tmpExists) {
    // Switch to tmp branch and reset to default HEAD
    await git.checkout(tmpBranchName);
    await git.reset(["--hard", targetCommit]);
  } else {
    // Create new tmp branch at default HEAD
    await git.checkout(["-B", tmpBranchName, targetCommit]);
  }

  return tmpBranchName;
}

// Stash changes in a worktree
export async function stashChanges(worktreePath: string, message?: string): Promise<void> {
  const git = simpleGit(worktreePath);
  const stashMessage = message || `Stash from release at ${new Date().toISOString()}`;
  await git.stash(["push", "-m", stashMessage, "--include-untracked"]);
}

// Clean all changes (discard modified + delete untracked)
export async function cleanChanges(worktreePath: string): Promise<void> {
  const git = simpleGit(worktreePath);
  // Reset tracked files
  await git.reset(["--hard", "HEAD"]);
  // Remove untracked files and directories
  await git.clean("fd");
}

// Amend changes to the last commit
export async function amendChanges(worktreePath: string): Promise<void> {
  const git = simpleGit(worktreePath);
  // Add all changes
  await git.add("-A");
  // Amend the commit
  await git.commit([], { "--amend": null, "--no-edit": null });
}

// Commit changes with a message
export async function commitChanges(worktreePath: string, message: string): Promise<void> {
  const git = simpleGit(worktreePath);
  // Add all changes
  await git.add("-A");
  // Create new commit
  await git.commit(message);
}

// Create a new worktree
export async function createWorktree(
  repoPath: string,
  worktreeName: string,
  config: RepositoryConfig
): Promise<{ path: string; branch: string }> {
  const git = simpleGit(repoPath);

  // Generate tmp branch name
  const tmpBranchName = `${TMP_BRANCH_PREFIX}${worktreeName}`;

  // Determine worktree directory
  const worktreeBaseDir = config.worktreeDirectory || path.join(repoPath, "..");
  const worktreePath = path.join(worktreeBaseDir, `${path.basename(repoPath)}-${worktreeName}`);

  // Get default branch
  const defaultBranch = await getDefaultBranch(repoPath, config);

  // Check if tmp branch already exists
  const exists = await branchExists(repoPath, tmpBranchName);

  if (exists) {
    // Create worktree with existing branch
    const branchCommit = await git.raw(["rev-parse", tmpBranchName]);
    await git.raw(["worktree", "add", "--detach", worktreePath, branchCommit.trim()]);
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.checkout(["-B", tmpBranchName, tmpBranchName]);
  } else {
    // Create new branch and worktree
    await git.raw(["worktree", "add", "-b", tmpBranchName, worktreePath, defaultBranch]);
  }

  return { path: worktreePath, branch: tmpBranchName };
}

// Run init command in worktree
export async function runInitCommand(
  worktreePath: string,
  initCommand: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Running init command: ${initCommand}`);

    const child = spawn(initCommand, {
      shell: true,
      cwd: worktreePath,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to run init command: ${getErrorMessage(error)}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Init command exited with code ${code}`));
      }
    });
  });
}

// Get local branch name from refs/heads/... format
export function getLocalBranchName(branch: string | null): string {
  if (!branch) return "(detached)";
  return branch.replace(/^refs\/heads\//, "");
}
