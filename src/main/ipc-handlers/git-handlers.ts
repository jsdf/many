import { ipcMain } from "electron";
import * as gitOps from "../git-operations";
import { AppData } from "../types";

export function registerGitHandlers(
  loadAppData: () => Promise<AppData>,
  terminalManager?: any
) {
  // Basic git operations
  ipcMain.handle("get-worktrees", async (event, repoPath) => {
    return gitOps.getWorktrees(repoPath);
  });

  ipcMain.handle("get-branches", async (event, repoPath) => {
    return gitOps.getBranches(repoPath);
  });

  ipcMain.handle("get-git-username", async (event, repoPath) => {
    return gitOps.getGitUsername(repoPath);
  });

  // Worktree management
  ipcMain.handle(
    "create-worktree",
    async (event, repoPath, branchName, baseBranch) => {
      const configData = await loadAppData();
      const repoConfiguration = configData.repositoryConfigs[repoPath];
      return gitOps.createWorktree(repoPath, branchName, baseBranch, repoConfiguration, terminalManager);
    }
  );

  ipcMain.handle(
    "archive-worktree",
    async (event, repoPath, worktreePath, force = false) => {
      const appData = await loadAppData();
      const repoConfig = appData.repositoryConfigs[repoPath] || {
        mainBranch: null,
        initCommand: null,
        worktreeDirectory: null,
      };
      return gitOps.archiveWorktree(repoPath, worktreePath, force, repoConfig);
    }
  );

  // Branch operations
  ipcMain.handle("check-branch-merged", async (event, repoPath, branchName) => {
    const appData = await loadAppData();
    const repoConfig = appData.repositoryConfigs[repoPath] || {
      mainBranch: null,
      initCommand: null,
      worktreeDirectory: null,
    };
    return gitOps.checkBranchMerged(repoPath, branchName, repoConfig);
  });

  ipcMain.handle(
    "merge-worktree",
    async (event, repoPath, fromBranch, toBranch, options) => {
      return gitOps.mergeWorktree(repoPath, fromBranch, toBranch, options);
    }
  );

  ipcMain.handle(
    "rebase-worktree",
    async (_, worktreePath, fromBranch, ontoBranch) => {
      return gitOps.rebaseWorktree(worktreePath, fromBranch, ontoBranch);
    }
  );

  // Status and logging
  ipcMain.handle("get-worktree-status", async (_, worktreePath) => {
    return gitOps.getWorktreeStatus(worktreePath);
  });

  ipcMain.handle("get-commit-log", async (_, worktreePath, baseBranch) => {
    return gitOps.getCommitLog(worktreePath, baseBranch);
  });
}