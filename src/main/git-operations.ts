import { simpleGit } from "simple-git";
import path from "path";

// Re-export shared types and utilities for consumers that import from this module
export {
  type ParsedWorktree,
  type GitStatus,
  TMP_BRANCH_PREFIX,
  getErrorMessage,
  extractWorktreeName,
  isTmpBranch,
  getLocalBranchName,
  branchExists,
  getWorktreeStatus,
  removeWorktree,
} from "../shared/git-core";

import {
  type ParsedWorktree,
  getErrorMessage,
  parseWorktreeList,
  getDefaultBranch as sharedGetDefaultBranch,
  branchExists,
  removeWorktree,
  extractWorktreeName,
  TMP_BRANCH_PREFIX,
  checkBranchMerged as sharedCheckBranchMerged,
  claimWorktree as sharedClaimWorktree,
  releaseWorktree as sharedReleaseWorktree,
  stashChanges as sharedStashChanges,
  cleanChanges as sharedCleanChanges,
  amendChanges as sharedAmendChanges,
  commitChanges as sharedCommitChanges,
} from "../shared/git-core";

// --- Worktree listing (UI format) ---

export const getWorktrees = async (
  repoPath: string
): Promise<ParsedWorktree[]> => {
  try {
    return await parseWorktreeList(repoPath);
  } catch (error) {
    throw new Error(`Failed to get worktrees: ${getErrorMessage(error)}`);
  }
};

// --- Branch listing ---

export const getBranches = async (repoPath: string) => {
  try {
    const git = simpleGit(repoPath);
    const branches = await git.branch(["--all"]);

    const localBranches = branches.all
      .filter((branch) => !branch.startsWith("remotes/"))
      .map((branch) => branch.replace("*", "").trim())
      .filter((branch) => branch.length > 0);

    return localBranches;
  } catch (error) {
    throw new Error(`Failed to get branches: ${getErrorMessage(error)}`);
  }
};

// --- Worktree creation (UI version with terminalManager) ---

export const createWorktree = async (
  repoPath: string,
  branchName: string,
  baseBranch: string,
  repoConfiguration: any,
  terminalManager?: any
) => {
  try {
    const git = simpleGit(repoPath);

    const sanitizedBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, "-");

    const worktreeBaseDir =
      repoConfiguration?.worktreeDirectory || path.join(repoPath, "..");

    const worktreePath = path.join(
      worktreeBaseDir,
      `${path.basename(repoPath)}-${sanitizedBranchName.replace(/\//g, "-")}`
    );

    const branchAlreadyExists = await branchExists(
      repoPath,
      sanitizedBranchName
    );

    if (branchAlreadyExists) {
      const branchCommit = await git.raw(["rev-parse", sanitizedBranchName]);
      await git.raw([
        "worktree",
        "add",
        "--detach",
        worktreePath,
        branchCommit.trim(),
      ]);

      const worktreeGit = simpleGit(worktreePath);
      await worktreeGit.checkout([
        "-B",
        sanitizedBranchName,
        sanitizedBranchName,
      ]);
    } else {
      await git.raw([
        "worktree",
        "add",
        "-b",
        sanitizedBranchName,
        worktreePath,
        baseBranch || "HEAD",
      ]);
    }

    if (repoConfiguration?.initCommand && terminalManager) {
      terminalManager.createSetupTerminal(
        worktreePath,
        repoConfiguration.initCommand
      );
    }

    return {
      path: worktreePath,
      branch: sanitizedBranchName,
      initCommand: repoConfiguration?.initCommand || null,
    };
  } catch (error) {
    throw new Error(`Failed to create worktree: ${getErrorMessage(error)}`);
  }
};

// --- Git username ---

export const getGitUsername = async (repoPath: string) => {
  try {
    const git = simpleGit(repoPath);
    const config = await git.listConfig();
    return config.all["user.name"] || "user";
  } catch {
    return "user";
  }
};

// --- Default branch (with config object interface) ---

export const getDefaultBranch = async (
  repoPath: string,
  repoConfig: any
): Promise<string> => {
  return sharedGetDefaultBranch(repoPath, repoConfig?.mainBranch || null);
};

// --- Branch merge check (with config object interface) ---

export const checkBranchMerged = async (
  repoPath: string,
  branchName: string,
  repoConfig: any
) => {
  try {
    const result = await sharedCheckBranchMerged(
      repoPath,
      branchName,
      repoConfig?.mainBranch || null
    );
    return result;
  } catch (error) {
    // If we can't determine merge status, assume it's not merged for safety
    const mainBranch = await sharedGetDefaultBranch(
      repoPath,
      repoConfig?.mainBranch || null
    );
    return {
      isFullyMerged: false,
      mainBranch,
      branchName,
      error: `Could not determine merge status: ${getErrorMessage(error)}`,
    };
  }
};

// --- Archive worktree (UI version with force/merge check/error types) ---

export const archiveWorktree = async (
  repoPath: string,
  worktreePath: string,
  force: boolean = false,
  repoConfig: any
) => {
  try {
    if (!force) {
      const worktrees = await parseWorktreeList(repoPath);
      const currentWorktree = worktrees.find((w) => w.path === worktreePath);

      if (currentWorktree && currentWorktree.branch) {
        if (repoConfig.mainBranch) {
          try {
            const result = await sharedCheckBranchMerged(
              repoPath,
              currentWorktree.branch,
              repoConfig.mainBranch
            );

            if (!result.isFullyMerged) {
              const error = new Error(
                `UNMERGED_BRANCH:Branch '${currentWorktree.branch}' is not fully merged into '${repoConfig.mainBranch}'.`
              );
              error.name = "UnmergedBranchError";
              throw error;
            }
          } catch (mergeCheckError: unknown) {
            const errorMsg = getErrorMessage(mergeCheckError);
            if (errorMsg.includes("UNMERGED_BRANCH:")) {
              throw mergeCheckError;
            }
            const error = new Error(
              `MERGE_CHECK_FAILED:Could not determine if branch '${currentWorktree.branch}' is merged into '${repoConfig.mainBranch}'.`
            );
            error.name = "MergeCheckFailedError";
            throw error;
          }
        }
      }
    }

    await removeWorktree(repoPath, worktreePath);
    return true;
  } catch (error) {
    console.error("Failed to archive worktree:", error);
    throw error;
  }
};

// --- Merge worktree ---

export const mergeWorktree = async (
  repoPath: string,
  fromBranch: string,
  toBranch: string,
  options: {
    squash?: boolean;
    noFF?: boolean;
    message?: string;
    deleteWorktree?: boolean;
    worktreePath?: string;
  }
) => {
  try {
    const git = simpleGit(repoPath);

    await git.checkout(toBranch);

    const mergeArgs = ["merge"];
    if (options.squash) mergeArgs.push("--squash");
    if (options.noFF) mergeArgs.push("--no-ff");
    if (options.message) mergeArgs.push("-m", options.message);
    mergeArgs.push(fromBranch);

    await git.raw(mergeArgs);

    if (options.squash) {
      const commitMessage =
        options.message || `Merge ${fromBranch} (squashed)`;
      await git.commit(commitMessage);
    }

    if (options.deleteWorktree && options.worktreePath) {
      await removeWorktree(repoPath, options.worktreePath);
    }

    return true;
  } catch (error) {
    console.error("Failed to merge worktree:", error);
    throw new Error(`Failed to merge worktree: ${getErrorMessage(error)}`);
  }
};

// --- Rebase worktree ---

export const rebaseWorktree = async (
  worktreePath: string,
  fromBranch: string,
  ontoBranch: string
) => {
  try {
    const git = simpleGit(worktreePath);
    await git.checkout(fromBranch);
    await git.raw(["rebase", ontoBranch]);
    return true;
  } catch (error) {
    console.error("Failed to rebase worktree:", error);
    throw new Error(`Failed to rebase worktree: ${getErrorMessage(error)}`);
  }
};

// --- Commit log ---

export const getCommitLog = async (
  worktreePath: string,
  baseBranch: string
) => {
  try {
    const git = simpleGit(worktreePath);
    const logOutput = await git.raw([
      "log",
      `${baseBranch}^..HEAD`,
      "--pretty=format:%s",
    ]);
    return logOutput.trim();
  } catch {
    return "";
  }
};

// --- Pool management wrappers (config object interface for API/IPC consumers) ---

export const claimWorktree = async (
  repoPath: string,
  worktreePath: string,
  branchName: string,
  repoConfig: any
): Promise<{ branch: string }> => {
  try {
    const branch = await sharedClaimWorktree(
      repoPath,
      worktreePath,
      branchName,
      repoConfig?.mainBranch || null
    );
    return { branch };
  } catch (error) {
    throw new Error(`Failed to claim worktree: ${getErrorMessage(error)}`);
  }
};

export const releaseWorktree = async (
  repoPath: string,
  worktreePath: string,
  repoConfig: any
): Promise<{ tmpBranch: string; previousBranch: string }> => {
  try {
    return await sharedReleaseWorktree(
      repoPath,
      worktreePath,
      repoConfig?.mainBranch || null
    );
  } catch (error) {
    throw new Error(`Failed to release worktree: ${getErrorMessage(error)}`);
  }
};

export const stashWorktreeChanges = async (
  worktreePath: string,
  message?: string
): Promise<void> => {
  try {
    await sharedStashChanges(worktreePath, message);
  } catch (error) {
    throw new Error(`Failed to stash changes: ${getErrorMessage(error)}`);
  }
};

export const cleanWorktreeChanges = async (
  worktreePath: string
): Promise<void> => {
  try {
    await sharedCleanChanges(worktreePath);
  } catch (error) {
    throw new Error(`Failed to clean changes: ${getErrorMessage(error)}`);
  }
};

export const amendWorktreeChanges = async (
  worktreePath: string
): Promise<void> => {
  try {
    await sharedAmendChanges(worktreePath);
  } catch (error) {
    throw new Error(`Failed to amend changes: ${getErrorMessage(error)}`);
  }
};

export const commitWorktreeChanges = async (
  worktreePath: string,
  message: string
): Promise<void> => {
  try {
    await sharedCommitChanges(worktreePath, message);
  } catch (error) {
    throw new Error(`Failed to commit changes: ${getErrorMessage(error)}`);
  }
};

export const createPoolWorktree = async (
  repoPath: string,
  worktreeName: string,
  repoConfig: any,
  terminalManager?: any
): Promise<{ path: string; branch: string }> => {
  try {
    const git = simpleGit(repoPath);

    const tmpBranchName = `${TMP_BRANCH_PREFIX}${worktreeName}`;

    const worktreeBaseDir =
      repoConfig?.worktreeDirectory || path.join(repoPath, "..");
    const worktreePath = path.join(
      worktreeBaseDir,
      `${path.basename(repoPath)}-${worktreeName}`
    );

    const defaultBranch = await sharedGetDefaultBranch(
      repoPath,
      repoConfig?.mainBranch || null
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

    if (repoConfig?.initCommand && terminalManager) {
      terminalManager.createSetupTerminal(worktreePath, repoConfig.initCommand);
    }

    return { path: worktreePath, branch: tmpBranchName };
  } catch (error) {
    throw new Error(`Failed to create pool worktree: ${getErrorMessage(error)}`);
  }
};
