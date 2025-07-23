import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { TerminalManager } from "./terminal-manager";
import * as gitOps from "./git-operations";
import * as externalActions from "./external-actions";

// Utility function to safely extract error message
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let mainWindow: BrowserWindow | null = null;
let terminalManager: TerminalManager;

// Type definitions
interface Repository {
  path: string;
  name: string;
  addedAt: string;
}

interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
}

interface TerminalConfig {
  id: string;
  title: string;
  type: 'terminal' | 'claude';
  initialCommand?: string;
}

interface WorktreeTerminals {
  terminals: TerminalConfig[];
  nextTerminalId: number;
}

interface AppData {
  repositories: Repository[];
  repositoryConfigs: Record<string, RepositoryConfig>;
  selectedRepo: string | null;
  windowBounds: { width: number; height: number; x?: number; y?: number };
  worktreeTerminals: Record<string, WorktreeTerminals>; // worktreePath -> terminal configs
}

// Get user data directory for storing app data
const userDataPath = app.getPath("userData");
const dataFilePath = path.join(userDataPath, "app-data.json");

// Default app data structure
const defaultAppData: AppData = {
  repositories: [],
  repositoryConfigs: {},
  selectedRepo: null,
  windowBounds: { width: 1200, height: 800 },
  worktreeTerminals: {},
};

// Load app data from disk
async function loadAppData() {
  try {
    const data = await fs.readFile(dataFilePath, "utf8");
    return { ...defaultAppData, ...JSON.parse(data) };
  } catch (error) {
    // File doesn't exist or is invalid, return defaults
    return defaultAppData;
  }
}

// Save app data to disk
async function saveAppData(data: AppData) {
  try {
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save app data:", error);
  }
}

async function createWindow() {
  const appData = await loadAppData();

  mainWindow = new BrowserWindow({
    width: appData.windowBounds.width,
    height: appData.windowBounds.height,
    x: appData.windowBounds.x,
    y: appData.windowBounds.y,
    icon: path.join(__dirname, "../../public/many-shodan.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });

  // Initialize terminal manager with main window
  terminalManager = new TerminalManager(mainWindow);

  // Save window bounds when moved or resized
  mainWindow.on("moved", saveWindowBounds);
  mainWindow.on("resized", saveWindowBounds);

  async function saveWindowBounds() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      const currentData = await loadAppData();
      currentData.windowBounds = bounds;
      await saveAppData(currentData);
    }
  }

  // In development, electron-vite will serve the renderer
  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle("get-worktrees", async (event, repoPath) => {
  return gitOps.getWorktrees(repoPath);
});

// Get available branches for a repository
ipcMain.handle("get-branches", async (event, repoPath) => {
  return gitOps.getBranches(repoPath);
});

ipcMain.handle(
  "create-worktree",
  async (event, repoPath, branchName, baseBranch) => {
    const configData = await loadAppData();
    const repoConfiguration = configData.repositoryConfigs[repoPath];
    return gitOps.createWorktree(repoPath, branchName, baseBranch, repoConfiguration);
  }
);

ipcMain.handle("get-git-username", async (event, repoPath) => {
  return gitOps.getGitUsername(repoPath);
});

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

ipcMain.handle("select-folder", async () => {
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

// Terminal-related IPC handlers
ipcMain.handle("create-terminal-session", async (event, options) => {
  return terminalManager.createTerminalSession(options);
});

ipcMain.handle("send-terminal-data", async (event, terminalId, data) => {
  return terminalManager.sendTerminalData(terminalId, data);
});

ipcMain.handle("resize-terminal", async (event, terminalId, cols, rows) => {
  terminalManager.resizeTerminal(terminalId, cols, rows);
});

ipcMain.handle("close-terminal", async (event, terminalId) => {
  terminalManager.closeTerminal(terminalId);
});

ipcMain.handle("terminal-session-exists", async (event, terminalId) => {
  return terminalManager.sessionExists(terminalId);
});

// Worktree terminal management
ipcMain.handle("get-worktree-terminals", async (event, worktreePath) => {
  try {
    const appData = await loadAppData();
    return appData.worktreeTerminals[worktreePath] || { terminals: [], nextTerminalId: 1 };
  } catch (error) {
    console.error("Failed to get worktree terminals:", error);
    return { terminals: [], nextTerminalId: 1 };
  }
});

ipcMain.handle("save-worktree-terminals", async (event, worktreePath, terminalConfig) => {
  try {
    const appData = await loadAppData();
    appData.worktreeTerminals[worktreePath] = terminalConfig;
    await saveAppData(appData);
    return true;
  } catch (error) {
    console.error("Failed to save worktree terminals:", error);
    return false;
  }
});

ipcMain.handle("cleanup-worktree-terminals", async (event, worktreePath) => {
  try {
    terminalManager.cleanupWorktreeTerminals(worktreePath);
    const appData = await loadAppData();
    delete appData.worktreeTerminals[worktreePath];
    await saveAppData(appData);
    return true;
  } catch (error) {
    console.error("Failed to cleanup worktree terminals:", error);
    return false;
  }
});

// Quick Actions IPC handlers
ipcMain.handle("open-in-file-manager", async (_, folderPath) => {
  return externalActions.openInFileManager(folderPath);
});

ipcMain.handle("open-in-editor", async (_, folderPath) => {
  return externalActions.openInEditor(folderPath);
});

ipcMain.handle("open-in-terminal", async (_, folderPath) => {
  return externalActions.openInTerminal(folderPath);
});

// Clean up terminals when app is about to quit
app.on("before-quit", () => {
  terminalManager?.cleanup();
});

// Get repository configuration
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

// Save repository configuration
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

// Open worktree directory in file manager
ipcMain.handle("open-directory", async (event, dirPath) => {
  return externalActions.openDirectory(dirPath);
});

// Open terminal in worktree directory
ipcMain.handle("open-terminal", async (event, dirPath) => {
  return externalActions.openTerminalInDirectory(dirPath);
});

// Open worktree in VS Code
ipcMain.handle("open-vscode", async (event, dirPath) => {
  return externalActions.openVSCode(dirPath);
});

// Check if a branch is fully merged into the main/default branch
ipcMain.handle("check-branch-merged", async (event, repoPath, branchName) => {
  const appData = await loadAppData();
  const repoConfig = appData.repositoryConfigs[repoPath] || {
    mainBranch: null,
    initCommand: null,
    worktreeDirectory: null,
  };
  return gitOps.checkBranchMerged(repoPath, branchName, repoConfig);
});

// Archive worktree (removes the working tree but keeps the branch)
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

// Merge worktree branch with options
ipcMain.handle(
  "merge-worktree",
  async (event, repoPath, fromBranch, toBranch, options) => {
    return gitOps.mergeWorktree(repoPath, fromBranch, toBranch, options);
  }
);

// Rebase worktree branch onto another branch
ipcMain.handle(
  "rebase-worktree",
  async (_, worktreePath, fromBranch, ontoBranch) => {
    return gitOps.rebaseWorktree(worktreePath, fromBranch, ontoBranch);
  }
);

// Get git status for a worktree
ipcMain.handle("get-worktree-status", async (_, worktreePath) => {
  return gitOps.getWorktreeStatus(worktreePath);
});

// Get git log for merge commit message
ipcMain.handle("get-commit-log", async (_, worktreePath, baseBranch) => {
  return gitOps.getCommitLog(worktreePath, baseBranch);
});
