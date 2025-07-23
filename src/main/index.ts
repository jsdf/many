import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { spawn } from "child_process";
import simpleGit from "simple-git";
import { TerminalManager } from "./terminal-manager";

const execAsync = promisify(exec);

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

interface AppData {
  repositories: Repository[];
  repositoryConfigs: Record<string, RepositoryConfig>;
  selectedRepo: string | null;
  windowBounds: { width: number; height: number; x?: number; y?: number };
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
  try {
    const git = simpleGit(repoPath);
    const worktrees = await git.raw(["worktree", "list", "--porcelain"]);

    interface WorktreeInfo {
      path?: string;
      commit?: string;
      branch?: string;
      bare?: boolean;
    }

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
});

// Get available branches for a repository
ipcMain.handle("get-branches", async (event, repoPath) => {
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
});

ipcMain.handle(
  "create-worktree",
  async (event, repoPath, branchName, baseBranch) => {
    try {
      const git = simpleGit(repoPath);

      // Use branch name as-is, no sanitization
      const sanitizedBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, "-");

      // Get repository configuration to determine worktree directory
      const configData = await loadAppData();
      const repoConfiguration = configData.repositoryConfigs[repoPath];
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

      // Execute initialization command if configured
      if (repoConfiguration?.initCommand) {
        try {
          console.log(
            `Running initialization command: ${repoConfiguration.initCommand}`
          );
          await execAsync(repoConfiguration.initCommand, { cwd: worktreePath });
        } catch (error) {
          console.warn(
            `Initialization command failed: ${getErrorMessage(error)}`
          );
          // Don't fail worktree creation if init command fails
        }
      }

      return { path: worktreePath, branch: sanitizedBranchName };
    } catch (error) {
      throw new Error(`Failed to create worktree: ${getErrorMessage(error)}`);
    }
  }
);

ipcMain.handle("get-git-username", async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const config = await git.listConfig();
    return config.all["user.name"] || "user";
  } catch (error) {
    return "user";
  }
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

// Quick Actions IPC handlers
ipcMain.handle("open-in-file-manager", async (_, folderPath) => {
  try {
    await shell.openPath(folderPath);
    return true;
  } catch (error) {
    console.error("Failed to open in file manager:", error);
    throw new Error(`Failed to open folder: ${getErrorMessage(error)}`);
  }
});

ipcMain.handle("open-in-editor", async (_, folderPath) => {
  try {
    // Try to open with VS Code first, then fall back to default editor
    const editors = ["code", "cursor", "subl", "atom"];

    for (const editor of editors) {
      try {
        spawn(editor, [folderPath], { detached: true, stdio: "ignore" });
        return true;
      } catch (error) {
        // Continue to next editor
        continue;
      }
    }

    // Fallback to system default
    await shell.openPath(folderPath);
    return true;
  } catch (error) {
    console.error("Failed to open in editor:", error);
    throw new Error(`Failed to open in editor: ${getErrorMessage(error)}`);
  }
});

ipcMain.handle("open-in-terminal", async (_, folderPath) => {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS - open Terminal.app
      spawn("open", ["-a", "Terminal", folderPath], {
        detached: true,
        stdio: "ignore",
      });
    } else if (platform === "win32") {
      // Windows - open Command Prompt
      spawn("cmd", ["/c", "start", "cmd", "/k", `cd /d "${folderPath}"`], {
        detached: true,
        stdio: "ignore",
      });
    } else {
      // Linux - try common terminals
      const terminals = ["gnome-terminal", "konsole", "xterm"];
      for (const terminal of terminals) {
        try {
          if (terminal === "gnome-terminal") {
            spawn(terminal, ["--working-directory", folderPath], {
              detached: true,
              stdio: "ignore",
            });
          } else {
            spawn(terminal, ["-e", "bash"], {
              cwd: folderPath,
              detached: true,
              stdio: "ignore",
            });
          }
          break;
        } catch (error) {
          continue;
        }
      }
    }
    return true;
  } catch (error) {
    console.error("Failed to open in terminal:", error);
    throw new Error(`Failed to open terminal: ${getErrorMessage(error)}`);
  }
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
  try {
    await shell.openPath(dirPath);
    return true;
  } catch (error) {
    console.error("Failed to open directory:", error);
    throw new Error(`Failed to open directory: ${getErrorMessage(error)}`);
  }
});

// Open terminal in worktree directory
ipcMain.handle("open-terminal", async (event, dirPath) => {
  try {
    const platform = process.platform;

    if (platform === "darwin") {
      // macOS - open Terminal.app
      await execAsync(`open -a Terminal "${dirPath}"`);
    } else if (platform === "win32") {
      // Windows - open Command Prompt
      await execAsync(`start cmd /K cd /d "${dirPath}"`);
    } else {
      // Linux - try common terminal emulators
      try {
        await execAsync(`gnome-terminal --working-directory="${dirPath}"`);
      } catch {
        try {
          await execAsync(`xfce4-terminal --working-directory="${dirPath}"`);
        } catch {
          await execAsync(`konsole --workdir "${dirPath}"`);
        }
      }
    }
    return true;
  } catch (error) {
    console.error("Failed to open terminal:", error);
    throw new Error(`Failed to open terminal: ${getErrorMessage(error)}`);
  }
});

// Open worktree in VS Code
ipcMain.handle("open-vscode", async (event, dirPath) => {
  try {
    await execAsync(`code "${dirPath}"`);
    return true;
  } catch (error) {
    console.error("Failed to open VS Code:", error);
    throw new Error(
      `Failed to open VS Code. Make sure 'code' command is installed: ${getErrorMessage(
        error
      )}`
    );
  }
});

// Archive worktree (removes the working tree but keeps the branch)
ipcMain.handle("archive-worktree", async (event, worktreePath) => {
  try {
    // Get the repository path from the worktree path
    const repoPath = path.dirname(worktreePath);
    const git = simpleGit(repoPath);

    // Remove the worktree
    await git.raw(["worktree", "remove", worktreePath]);

    return true;
  } catch (error) {
    console.error("Failed to archive worktree:", error);
    throw new Error(`Failed to archive worktree: ${getErrorMessage(error)}`);
  }
});

// Merge worktree branch with options
ipcMain.handle(
  "merge-worktree",
  async (event, repoPath, fromBranch, toBranch, options) => {
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
        await git.raw(["worktree", "remove", options.worktreePath]);
      }

      return true;
    } catch (error) {
      console.error("Failed to merge worktree:", error);
      throw new Error(`Failed to merge worktree: ${getErrorMessage(error)}`);
    }
  }
);

// Rebase worktree branch onto another branch
ipcMain.handle(
  "rebase-worktree",
  async (event, worktreePath, fromBranch, ontoBranch) => {
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
  }
);

// Get git status for a worktree
ipcMain.handle("get-worktree-status", async (event, worktreePath) => {
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
});

// Get git log for merge commit message
ipcMain.handle("get-commit-log", async (event, worktreePath, baseBranch) => {
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
});
