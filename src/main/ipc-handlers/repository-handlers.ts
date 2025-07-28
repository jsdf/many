import { ipcMain, dialog, BrowserWindow } from "electron";
import path from "path";
import { AppData, Repository, RepositoryConfig } from "../types";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRepositoryHandlers(
  loadAppData: () => Promise<AppData>,
  saveAppData: (data: AppData) => Promise<void>,
  getMainWindow: () => BrowserWindow | null
) {
  // Repository CRUD operations
  ipcMain.handle("get-saved-repos", async () => {
    try {
      const appData = await loadAppData();
      return appData.repositories;
    } catch (error) {
      console.error("Failed to get saved repos:", error);
      return [];
    }
  });

  ipcMain.handle("save-repo", async (event, repoPath) => {
    try {
      const appData = await loadAppData();

      // Check if repo already exists
      const exists = appData.repositories.some(
        (repo: Repository) => repo.path === repoPath
      );
      if (!exists) {
        // Get repo name from path
        const repoName = path.basename(repoPath);
        appData.repositories.push({
          path: repoPath,
          name: repoName,
          addedAt: new Date().toISOString(),
        });
        await saveAppData(appData);
      }

      return true;
    } catch (error) {
      console.error("Failed to save repo:", error);
      throw new Error(`Failed to save repository: ${getErrorMessage(error)}`);
    }
  });

  // Repository selection
  ipcMain.handle("get-selected-repo", async () => {
    try {
      const appData = await loadAppData();
      return appData.selectedRepo;
    } catch (error) {
      console.error("Failed to get selected repo:", error);
      return null;
    }
  });

  ipcMain.handle("set-selected-repo", async (event, repoPath) => {
    try {
      const appData = await loadAppData();
      appData.selectedRepo = repoPath;
      await saveAppData(appData);
      return true;
    } catch (error) {
      console.error("Failed to set selected repo:", error);
      throw new Error(
        `Failed to save selected repository: ${getErrorMessage(error)}`
      );
    }
  });

  // Repository configuration
  ipcMain.handle("get-repo-config", async (event, repoPath) => {
    try {
      const appData = await loadAppData();
      return (
        appData.repositoryConfigs[repoPath] || {
          mainBranch: null,
          initCommand: null,
          worktreeDirectory: null,
        }
      );
    } catch (error) {
      console.error("Failed to get repo config:", error);
      return { mainBranch: null, initCommand: null, worktreeDirectory: null };
    }
  });

  ipcMain.handle("save-repo-config", async (event, repoPath, config) => {
    try {
      const appData = await loadAppData();
      appData.repositoryConfigs[repoPath] = config;
      await saveAppData(appData);
      return true;
    } catch (error) {
      console.error("Failed to save repo config:", error);
      throw new Error(
        `Failed to save repository config: ${getErrorMessage(error)}`
      );
    }
  });

  // Recent worktree tracking
  ipcMain.handle("get-recent-worktree", async (_, repoPath) => {
    try {
      const appData = await loadAppData();
      return appData.recentWorktrees[repoPath] || null;
    } catch (error) {
      console.error("Failed to get recent worktree:", error);
      return null;
    }
  });

  ipcMain.handle("set-recent-worktree", async (_, repoPath, worktreePath) => {
    try {
      const appData = await loadAppData();
      appData.recentWorktrees[repoPath] = worktreePath;
      await saveAppData(appData);
      return true;
    } catch (error) {
      console.error("Failed to set recent worktree:", error);
      return false;
    }
  });

  // Folder selection dialog
  ipcMain.handle("select-folder", async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      throw new Error("Main window not available");
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Select Git Repository Folder",
    });

    if (result.canceled) {
      return null;
    }

    return result.filePaths[0];
  });
}