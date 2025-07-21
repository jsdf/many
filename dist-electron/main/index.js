"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
let mainWindow = null;
const userDataPath = electron.app.getPath("userData");
const dataFilePath = path.join(userDataPath, "app-data.json");
const defaultAppData = {
  repositories: [],
  selectedRepo: null,
  windowBounds: { width: 1200, height: 800 }
};
async function loadAppData() {
  try {
    const data = await fs.promises.readFile(dataFilePath, "utf8");
    return { ...defaultAppData, ...JSON.parse(data) };
  } catch (error) {
    return defaultAppData;
  }
}
async function saveAppData(data) {
  try {
    await fs.promises.mkdir(userDataPath, { recursive: true });
    await fs.promises.writeFile(dataFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save app data:", error);
  }
}
async function createWindow() {
  const appData = await loadAppData();
  mainWindow = new electron.BrowserWindow({
    width: appData.windowBounds.width,
    height: appData.windowBounds.height,
    x: appData.windowBounds.x,
    y: appData.windowBounds.y,
    icon: path.join(__dirname, "logo.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "../preload/index.js")
    }
  });
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
  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}
electron.app.whenReady().then(createWindow);
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("activate", () => {
  if (electron.BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
electron.ipcMain.handle("get-worktrees", async (event, repoPath) => {
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
electron.ipcMain.handle("create-worktree", async (event, repoPath, branchName) => {
  try {
    const git = simpleGit(repoPath);
    const sanitizedBranchName = branchName.replace(/[^a-zA-Z0-9\-_\/]/g, "-");
    const worktreePath = path.join(repoPath, "..", `${path.basename(repoPath)}-${sanitizedBranchName.replace(/\//g, "-")}`);
    const branches = await git.branch();
    const branchExists = branches.all.includes(sanitizedBranchName);
    if (branchExists) {
      const branchCommit = await git.raw(["rev-parse", sanitizedBranchName]);
      await git.raw(["worktree", "add", "--detach", worktreePath, branchCommit.trim()]);
      const worktreeGit = simpleGit(worktreePath);
      await worktreeGit.checkout(["-B", sanitizedBranchName, sanitizedBranchName]);
    } else {
      await git.raw(["worktree", "add", "-b", sanitizedBranchName, worktreePath]);
    }
    return { path: worktreePath, branch: sanitizedBranchName };
  } catch (error) {
    throw new Error(`Failed to create worktree: ${error.message}`);
  }
});
electron.ipcMain.handle("get-git-username", async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const config = await git.listConfig();
    return config.all["user.name"] || "user";
  } catch (error) {
    return "user";
  }
});
electron.ipcMain.handle("get-saved-repos", async () => {
  try {
    const appData = await loadAppData();
    return appData.repositories;
  } catch (error) {
    console.error("Failed to get saved repos:", error);
    return [];
  }
});
electron.ipcMain.handle("save-repo", async (event, repoPath) => {
  try {
    const appData = await loadAppData();
    const exists = appData.repositories.some((repo) => repo.path === repoPath);
    if (!exists) {
      const repoName = path.basename(repoPath);
      appData.repositories.push({
        path: repoPath,
        name: repoName,
        addedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      await saveAppData(appData);
    }
    return true;
  } catch (error) {
    console.error("Failed to save repo:", error);
    throw new Error(`Failed to save repository: ${error.message}`);
  }
});
electron.ipcMain.handle("get-selected-repo", async () => {
  try {
    const appData = await loadAppData();
    return appData.selectedRepo;
  } catch (error) {
    console.error("Failed to get selected repo:", error);
    return null;
  }
});
electron.ipcMain.handle("set-selected-repo", async (event, repoPath) => {
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
electron.ipcMain.handle("select-folder", async () => {
  const result = await electron.dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select Git Repository Folder"
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});
