export interface Repository {
  path: string;
  name?: string;
  addedAt?: string;
}

export interface Worktree {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  isAvailable: boolean;
  worktreeName: string;
}

// Helper to check if a branch is a pool tmp branch
export const isTmpBranch = (branch?: string | null): boolean => {
  if (!branch) return false;
  const localBranch = branch.replace(/^refs\/heads\//, "");
  return localBranch.startsWith("tmp-");
};

// Helper to extract worktree name from path
export const extractWorktreeName = (worktreePath: string, repoPath: string): string => {
  const baseName = repoPath.split("/").pop() || "";
  const worktreeDirName = worktreePath.split("/").pop() || "";

  if (worktreeDirName.startsWith(baseName + "-")) {
    return worktreeDirName.substring(baseName.length + 1);
  }
  return worktreeDirName;
};

// Pool change handling options
export type ChangeHandlingOption = "stash" | "commit" | "amend" | "clean" | "cancel";

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
}

export interface MergeOptions {
  squash: boolean;
  noFF: boolean;
  message: string;
  deleteWorktree: boolean;
  worktreePath?: string;
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
