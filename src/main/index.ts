import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import simpleGit from "simple-git";

const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;

// Get user data directory for storing app data
const userDataPath = app.getPath("userData");
const dataFilePath = path.join(userDataPath, "app-data.json");

// Default app data structure
const defaultAppData = {
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
async function saveAppData(data: any) {
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

    const parsed = [];
    const lines = worktrees.split("\n");
    let current = {};

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
    throw new Error(`Failed to get worktrees: ${error.message}`);
  }
});

// Get available branches for a repository
ipcMain.handle("get-branches", async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const branches = await git.branch(['--all']);
    
    // Filter and clean branch names
    const localBranches = branches.all
      .filter(branch => !branch.startsWith('remotes/'))
      .map(branch => branch.replace('*', '').trim())
      .filter(branch => branch.length > 0);
    
    return localBranches;
  } catch (error) {
    throw new Error(`Failed to get branches: ${error.message}`);
  }
});

ipcMain.handle("create-worktree", async (event, repoPath, branchName, baseBranch) => {
  try {
    const git = simpleGit(repoPath);

    // Use branch name as-is, no sanitization
    const sanitizedBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, "-");
    const worktreePath = path.join(
      repoPath,
      "..",
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
        baseBranch || "HEAD"
      ]);
    }

    return { path: worktreePath, branch: sanitizedBranchName };
  } catch (error) {
    throw new Error(`Failed to create worktree: ${error.message}`);
  }
});

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
    const exists = appData.repositories.some((repo) => repo.path === repoPath);
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
    throw new Error(`Failed to save repository: ${error.message}`);
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
    throw new Error(`Failed to save selected repository: ${error.message}`);
  }
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Git Repository Folder",
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});

// Get repository configuration
ipcMain.handle("get-repo-config", async (event, repoPath) => {
  try {
    const appData = await loadAppData();
    return appData.repositoryConfigs[repoPath] || { mainBranch: null };
  } catch (error) {
    console.error("Failed to get repo config:", error);
    return { mainBranch: null };
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
    throw new Error(`Failed to save repository config: ${error.message}`);
  }
});

// Open worktree directory in file manager
ipcMain.handle("open-directory", async (event, dirPath) => {
  try {
    await shell.openPath(dirPath);
    return true;
  } catch (error) {
    console.error("Failed to open directory:", error);
    throw new Error(`Failed to open directory: ${error.message}`);
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
    throw new Error(`Failed to open terminal: ${error.message}`);
  }
});

// Open worktree in VS Code
ipcMain.handle("open-vscode", async (event, dirPath) => {
  try {
    await execAsync(`code "${dirPath}"`);
    return true;
  } catch (error) {
    console.error("Failed to open VS Code:", error);
    throw new Error(`Failed to open VS Code. Make sure 'code' command is installed: ${error.message}`);
  }
});
