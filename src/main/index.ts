import { app, BrowserWindow } from "electron";
import path from "path";
import { promises as fs } from "fs";
import { TerminalManager } from "./terminal-manager";
import { AppData } from "./types";
import { registerRepositoryHandlers } from "./ipc-handlers/repository-handlers";
import { registerGitHandlers } from "./ipc-handlers/git-handlers";
import { registerTerminalHandlers } from "./ipc-handlers/terminal-handlers";
import { registerExternalActionHandlers } from "./ipc-handlers/external-action-handlers";
import { router } from "./api";
import { createIPCHandler } from "electron-trpc/main";

let mainWindow: BrowserWindow | null = null;
let terminalManager: TerminalManager;

// Get user data directory for storing app data
const userDataPath = app.getPath("userData");
const dataFilePath = path.join(userDataPath, "app-data.json");

// Default app data structure
const defaultAppData: AppData = {
  repositories: [],
  repositoryConfigs: {},
  selectedRepo: null,
  recentWorktrees: {},
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

  createIPCHandler({ router, windows: [mainWindow] });

  // Initialize terminal manager with main window
  terminalManager = new TerminalManager(mainWindow);

  // Register all IPC handlers
  registerRepositoryHandlers(loadAppData, saveAppData, () => mainWindow);
  registerGitHandlers(loadAppData);
  registerTerminalHandlers(terminalManager, loadAppData, saveAppData);
  registerExternalActionHandlers();

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

// Clean up terminals when app is about to quit
app.on("before-quit", () => {
  terminalManager?.cleanup();
});
