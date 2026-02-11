// Git pool management - treating worktrees as a claimable pool
import { simpleGit } from "simple-git";
import path from "path";
import { spawn } from "child_process";
import { RepositoryConfig } from "./config.js";

// Re-export shared types and utilities for consumers
export {
  type GitStatus,
  TMP_BRANCH_PREFIX,
  getLocalBranchName,
} from "../shared/git-core.js";

import {
  type ParsedWorktree,
  TMP_BRANCH_PREFIX,
  getErrorMessage,
  extractWorktreeName,
  isTmpBranch,
  parseWorktreeList,
  getDefaultBranch as sharedGetDefaultBranch,
  branchExists,
  getWorktreeStatus as sharedGetWorktreeStatus,
  checkBranchMerged as sharedCheckBranchMerged,
  removeWorktree,
  stashChanges as sharedStashChanges,
  cleanChanges as sharedCleanChanges,
  amendChanges as sharedAmendChanges,
  commitChanges as sharedCommitChanges,
  claimWorktree as sharedClaimWorktree,
  releaseWorktree as sharedReleaseWorktree,
} from "../shared/git-core.js";

// --- CLI-specific WorktreeInfo with pool availability ---

export interface WorktreeInfo {
  path: string;
  commit: string;
  branch: string | null;
  bare: boolean;
  isAvailable: boolean; // true if on a tmp branch (available in pool)
  worktreeName: string; // extracted name from directory
}

// --- Worktree listing with pool enrichment ---

export async function getWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const parsed = await parseWorktreeList(repoPath);

    return parsed.map((w) => ({
      path: w.path,
      commit: w.commit || "",
      branch: w.branch || null,
      bare: w.bare || false,
      isAvailable: isTmpBranch(w.branch),
      worktreeName: extractWorktreeName(w.path, repoPath),
    }));
  } catch (error) {
    throw new Error(`Failed to get worktrees: ${getErrorMessage(error)}`);
  }
}

export async function getAvailableWorktrees(
  repoPath: string
): Promise<WorktreeInfo[]> {
  const worktrees = await getWorktrees(repoPath);
  return worktrees.filter((w) => w.isAvailable && !w.bare);
}

export async function getClaimedWorktrees(
  repoPath: string
): Promise<WorktreeInfo[]> {
  const worktrees = await getWorktrees(repoPath);
  return worktrees.filter((w) => !w.isAvailable && !w.bare);
}

export async function findWorktree(
  repoPath: string,
  identifier: string
): Promise<WorktreeInfo | null> {
  const worktrees = await getWorktrees(repoPath);

  const normalizedId = identifier.replace(/^refs\/heads\//, "");
  let match = worktrees.find((w) => {
    if (!w.branch) return false;
    const localBranch = w.branch.replace(/^refs\/heads\//, "");
    return localBranch === normalizedId;
  });

  if (match) return match;

  match = worktrees.find((w) => w.worktreeName === identifier);

  return match || null;
}

// --- Thin wrappers that accept RepositoryConfig ---

export async function getWorktreeStatus(
  worktreePath: string
) {
  return sharedGetWorktreeStatus(worktreePath);
}

export async function getDefaultBranch(
  repoPath: string,
  config: RepositoryConfig
): Promise<string> {
  return sharedGetDefaultBranch(repoPath, config.mainBranch);
}

export async function checkBranchMerged(
  repoPath: string,
  branchName: string,
  config: RepositoryConfig
): Promise<{ isFullyMerged: boolean; mainBranch: string }> {
  return sharedCheckBranchMerged(repoPath, branchName, config.mainBranch);
}

export async function archiveWorktree(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  return removeWorktree(repoPath, worktreePath);
}

export async function claimWorktree(
  repoPath: string,
  worktree: WorktreeInfo,
  branchName: string,
  config: RepositoryConfig
): Promise<void> {
  await sharedClaimWorktree(
    repoPath,
    worktree.path,
    branchName,
    config.mainBranch
  );
}

export async function releaseWorktree(
  repoPath: string,
  worktree: WorktreeInfo,
  config: RepositoryConfig
): Promise<string> {
  const result = await sharedReleaseWorktree(
    repoPath,
    worktree.path,
    config.mainBranch
  );
  return result.tmpBranch;
}

export async function stashChanges(
  worktreePath: string,
  message?: string
): Promise<void> {
  return sharedStashChanges(worktreePath, message);
}

export async function cleanChanges(worktreePath: string): Promise<void> {
  return sharedCleanChanges(worktreePath);
}

export async function amendChanges(worktreePath: string): Promise<void> {
  return sharedAmendChanges(worktreePath);
}

export async function commitChanges(
  worktreePath: string,
  message: string
): Promise<void> {
  return sharedCommitChanges(worktreePath, message);
}

// --- Pool worktree creation ---

export async function createWorktree(
  repoPath: string,
  worktreeName: string,
  config: RepositoryConfig
): Promise<{ path: string; branch: string }> {
  const git = simpleGit(repoPath);

  const tmpBranchName = `${TMP_BRANCH_PREFIX}${worktreeName}`;

  const worktreeBaseDir =
    config.worktreeDirectory || path.join(repoPath, "..");
  const worktreePath = path.join(
    worktreeBaseDir,
    `${path.basename(repoPath)}-${worktreeName}`
  );

  const defaultBranch = await sharedGetDefaultBranch(
    repoPath,
    config.mainBranch
  );

  const exists = await branchExists(repoPath, tmpBranchName);

  if (exists) {
    const branchCommit = await git.raw(["rev-parse", tmpBranchName]);
    await git.raw([
      "worktree",
      "add",
      "--detach",
      worktreePath,
      branchCommit.trim(),
    ]);
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.checkout(["-B", tmpBranchName, tmpBranchName]);
  } else {
    await git.raw([
      "worktree",
      "add",
      "-b",
      tmpBranchName,
      worktreePath,
      defaultBranch,
    ]);
  }

  return { path: worktreePath, branch: tmpBranchName };
}

// --- Init command ---

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
      reject(
        new Error(`Failed to run init command: ${getErrorMessage(error)}`)
      );
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
