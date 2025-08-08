import simpleGit from "simple-git";
import path from "path";
import { promises as fs } from "fs";

// Utility function to safely extract error message
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorktreeInfo {
  path?: string;
  commit?: string;
  branch?: string;
  bare?: boolean;
}

export const getWorktrees = async (repoPath: string) => {
  try {
    const git = simpleGit(repoPath);
    const worktrees = await git.raw(["worktree", "list", "--porcelain"]);

    const parsed: WorktreeInfo[] = [];
    const lines = worktrees.split("\n");
    let current: WorktreeInfo = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        if (current.path) parsed.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith("HEAD ")) {
        current.commit = line.substring(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.substring(7);
      } else if (line.startsWith("bare")) {
        current.bare = true;
      }
    }
    if (current.path) parsed.push(current);

    return parsed;
  } catch (error) {
    throw new Error(`Failed to get worktrees: ${getErrorMessage(error)}`);
  }
};

export const getBranches = async (repoPath: string) => {
  try {
    const git = simpleGit(repoPath);
    const branches = await git.branch(["--all"]);

    // Filter and clean branch names
    const localBranches = branches.all
      .filter((branch) => !branch.startsWith("remotes/"))
      .map((branch) => branch.replace("*", "").trim())
      .filter((branch) => branch.length > 0);

    return localBranches;
  } catch (error) {
    throw new Error(`Failed to get branches: ${getErrorMessage(error)}`);
  }
};

export const createWorktree = async (
  repoPath: string,
  branchName: string,
  baseBranch: string,
  repoConfiguration: any,
  terminalManager?: any
) => {
  try {
    const git = simpleGit(repoPath);

    // Use branch name as-is, no sanitization
    const sanitizedBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, "-");

    // Get repository configuration to determine worktree directory
    const worktreeBaseDir =
      repoConfiguration?.worktreeDirectory || path.join(repoPath, "..");

    const worktreePath = path.join(
      worktreeBaseDir,
      `${path.basename(repoPath)}-${sanitizedBranchName.replace(/\//g, "-")}`
    );

    // Check if branch already exists
    const branches = await git.branch();
    const branchExists = branches.all.includes(sanitizedBranchName);

    if (branchExists) {
      // Branch exists, create worktree with detached HEAD then checkout branch
      // This works whether the branch is checked out elsewhere or not
      const branchCommit = await git.raw(["rev-parse", sanitizedBranchName]);
      await git.raw([
        "worktree",
        "add",
        "--detach",
        worktreePath,
        branchCommit.trim(),
      ]);

      // After creating detached worktree, checkout the branch within the worktree
      const worktreeGit = simpleGit(worktreePath);
      await worktreeGit.checkout([
        "-B",
        sanitizedBranchName,
        sanitizedBranchName,
      ]);
    } else {
      // Create new branch and worktree in one step, based on the specified base branch
      await git.raw([
        "worktree",
        "add",
        "-b",
        sanitizedBranchName,
        worktreePath,
        baseBranch || "HEAD",
      ]);
    }

    // Create setup terminal if initCommand exists and terminalManager is provided
    if (repoConfiguration?.initCommand && terminalManager) {
      terminalManager.createSetupTerminal(worktreePath, repoConfiguration.initCommand);
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

export const getGitUsername = async (repoPath: string) => {
  try {
    const git = simpleGit(repoPath);
    const config = await git.listConfig();
    return config.all["user.name"] || "user";
  } catch (error) {
    return "user";
  }
};

export const checkBranchMerged = async (
  repoPath: string,
  branchName: string,
  repoConfig: any
) => {
  try {
    const git = simpleGit(repoPath);

    // Determine the main branch
    let mainBranch = repoConfig.mainBranch;

    if (!mainBranch) {
      // Try to detect the default branch if not configured
      try {
        // Get the default branch from remote origin
        const remoteResult = await git.raw([
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
        ]);
        mainBranch = remoteResult.trim().replace("refs/remotes/origin/", "");
      } catch {
        // Fall back to common default branch names
        const branches = await git.branch();
        if (branches.all.includes("main")) {
          mainBranch = "main";
        } else if (branches.all.includes("master")) {
          mainBranch = "master";
        } else if (branches.all.includes("develop")) {
          mainBranch = "develop";
        } else {
          // Use the current branch if no default found
          mainBranch = branches.current;
        }
      }
    }

    // Check if branch is fully merged into main branch
    try {
      // Use git merge-base to check if the branch is an ancestor of main
      const mergeBase = await git.raw(["merge-base", branchName, mainBranch]);
      const branchCommit = await git.raw(["rev-parse", branchName]);

      // If the merge base equals the branch commit, the branch is fully merged
      const isFullyMerged = mergeBase.trim() === branchCommit.trim();

      return {
        isFullyMerged,
        mainBranch,
        branchName,
      };
    } catch (error) {
      // If we can't determine merge status, assume it's not merged for safety
      return {
        isFullyMerged: false,
        mainBranch,
        branchName,
        error: `Could not determine merge status: ${getErrorMessage(error)}`,
      };
    }
  } catch (error) {
    console.error("Failed to check branch merge status:", error);
    throw new Error(
      `Failed to check branch merge status: ${getErrorMessage(error)}`
    );
  }
};

export const archiveWorktree = async (
  repoPath: string,
  worktreePath: string,
  force: boolean = false,
  repoConfig: any
) => {
  try {
    const git = simpleGit(repoPath);

    if (!force) {
      // Get the branch name for this worktree by parsing worktree list
      const worktreeList = await git.raw(["worktree", "list", "--porcelain"]);

      // Parse worktree list to find the branch for this worktree
      const parsed: WorktreeInfo[] = [];
      const lines = worktreeList.split("\n");
      let current: WorktreeInfo = {};

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          if (current.path) parsed.push(current);
          current = { path: line.substring(9) };
        } else if (line.startsWith("HEAD ")) {
          current.commit = line.substring(5);
        } else if (line.startsWith("branch ")) {
          current.branch = line.substring(7);
        } else if (line.startsWith("bare")) {
          current.bare = true;
        }
      }
      if (current.path) parsed.push(current);

      const currentWorktree = parsed.find((w) => w.path === worktreePath);

      if (currentWorktree && currentWorktree.branch) {
        // Only check merge status if main branch is configured
        if (repoConfig.mainBranch) {
          try {
            // Use git merge-base to check if the branch is an ancestor of main
            const mergeBase = await git.raw([
              "merge-base",
              currentWorktree.branch,
              repoConfig.mainBranch,
            ]);
            const branchCommit = await git.raw([
              "rev-parse",
              currentWorktree.branch,
            ]);

            // If the merge base equals the branch commit, the branch is fully merged
            const isFullyMerged = mergeBase.trim() === branchCommit.trim();

            if (!isFullyMerged) {
              // Return a special error that the frontend can handle for user confirmation
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
            // If we can't determine merge status, return a warning that the frontend can handle
            const error = new Error(
              `MERGE_CHECK_FAILED:Could not determine if branch '${currentWorktree.branch}' is merged into '${repoConfig.mainBranch}'.`
            );
            error.name = "MergeCheckFailedError";
            throw error;
          }
        }
      }
    }

    // First, try to remove the worktree using git (this handles the git cleanup)
    try {
      await git.raw(["worktree", "remove", "--force", worktreePath]);
    } catch (gitError) {
      // If git worktree remove fails, we need to manually delete the directory
      // and then remove the worktree registration
      console.log(`Git worktree remove failed, manually cleaning up: ${getErrorMessage(gitError)}`);
      
      try {
        // Check if directory exists before trying to delete it
        await fs.access(worktreePath);
        
        // Recursively delete the directory
        await fs.rm(worktreePath, { recursive: true, force: true });
        
        // Now try to remove the worktree registration again
        await git.raw(["worktree", "remove", worktreePath]);
      } catch (manualCleanupError) {
        // If manual cleanup also fails, try the prune command to clean up stale worktree references
        console.log(`Manual cleanup failed, trying prune: ${getErrorMessage(manualCleanupError)}`);
        
        try {
          // Remove stale worktree entries
          await git.raw(["worktree", "prune"]);
        } catch (pruneError) {
          console.log(`Prune also failed: ${getErrorMessage(pruneError)}`);
        }
        
        // Check if directory still exists and remove it if it does
        try {
          await fs.access(worktreePath);
          await fs.rm(worktreePath, { recursive: true, force: true });
        } catch (finalCleanupError) {
          // Directory might already be gone, which is fine
        }
      }
    }

    return true;
  } catch (error) {
    console.error("Failed to archive worktree:", error);
    throw error; // Re-throw to preserve error type for frontend handling
  }
};

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

    // Switch to target branch
    await git.checkout(toBranch);

    // Prepare merge command
    const mergeArgs = ["merge"];

    if (options.squash) {
      mergeArgs.push("--squash");
    }

    if (options.noFF) {
      mergeArgs.push("--no-ff");
    }

    if (options.message) {
      mergeArgs.push("-m", options.message);
    }

    mergeArgs.push(fromBranch);

    // Execute merge
    await git.raw(mergeArgs);

    // If squash merge, we need to commit
    if (options.squash) {
      const commitMessage =
        options.message || `Merge ${fromBranch} (squashed)`;
      await git.commit(commitMessage);
    }

    // Archive worktree if requested
    if (options.deleteWorktree && options.worktreePath) {
      try {
        await git.raw(["worktree", "remove", "--force", options.worktreePath]);
      } catch (gitError) {
        // If git worktree remove fails, manually delete the directory
        console.log(`Git worktree remove failed during merge, manually cleaning up: ${getErrorMessage(gitError)}`);
        
        try {
          await fs.access(options.worktreePath);
          await fs.rm(options.worktreePath, { recursive: true, force: true });
          await git.raw(["worktree", "remove", options.worktreePath]);
        } catch (cleanupError) {
          console.log(`Manual cleanup during merge failed: ${getErrorMessage(cleanupError)}`);
          // Try prune to clean up stale references
          try {
            await git.raw(["worktree", "prune"]);
            await fs.rm(options.worktreePath, { recursive: true, force: true });
          } catch (finalError) {
            // Log but don't fail the merge operation
            console.log(`Final cleanup attempt failed: ${getErrorMessage(finalError)}`);
          }
        }
      }
    }

    return true;
  } catch (error) {
    console.error("Failed to merge worktree:", error);
    throw new Error(`Failed to merge worktree: ${getErrorMessage(error)}`);
  }
};

export const rebaseWorktree = async (
  worktreePath: string,
  fromBranch: string,
  ontoBranch: string
) => {
  try {
    // Use the worktree-specific git instance
    const git = simpleGit(worktreePath);

    // Ensure we're on the correct branch
    await git.checkout(fromBranch);

    // Execute rebase
    await git.raw(["rebase", ontoBranch]);

    return true;
  } catch (error) {
    console.error("Failed to rebase worktree:", error);
    throw new Error(`Failed to rebase worktree: ${getErrorMessage(error)}`);
  }
};

export const getWorktreeStatus = async (worktreePath: string) => {
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
    console.error("Failed to get worktree status:", error);
    throw new Error(`Failed to get worktree status: ${getErrorMessage(error)}`);
  }
};

export const getCommitLog = async (worktreePath: string, baseBranch: string) => {
  try {
    const git = simpleGit(worktreePath);

    // Get commits between base branch and HEAD with just the commit messages
    const logOutput = await git.raw([
      "log",
      `${baseBranch}^..HEAD`,
      "--pretty=format:%s",
    ]);

    return logOutput.trim();
  } catch (error) {
    console.error("Failed to get commit log:", error);
    // Return fallback message if git log fails
    return "";
  }
};