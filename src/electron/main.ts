import { app, BrowserWindow, shell } from "electron";
import crypto from "crypto";
import { loadAppData, withAppData } from "../cli/config.js";

let mainWindow: BrowserWindow | null = null;
let serverUrl: string | null = null;
let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;

async function createWindow(url: string) {
  let bounds = { width: 1200, height: 800, x: undefined as number | undefined, y: undefined as number | undefined };
  try {
    const appData = await loadAppData();
    if (appData.windowBounds) {
      bounds = { ...bounds, ...appData.windowBounds };
    }
  } catch {
    // Use defaults if config can't be loaded
  }

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 800,
    minHeight: 500,
    title: "Many",
    titleBarStyle: "default",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(url);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl!)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Intercept link clicks that would navigate the main window away from the app
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(serverUrl!)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Save window bounds on resize/move (debounced)
  const saveBounds = () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(async () => {
      if (!mainWindow) return;
      const [width, height] = mainWindow.getSize();
      const [x, y] = mainWindow.getPosition();
      try {
        await withAppData((appData) => {
          appData.windowBounds = { width, height, x, y };
        });
      } catch {
        // Non-critical, ignore save failures
      }
    }, 500);
  };

  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const { startWebServer } = await import("../web/server.js");

    const token = crypto.randomBytes(24).toString("hex");
    const result = await startWebServer({ port: 0, open: false, token });
    serverUrl = result.url;

    await createWindow(serverUrl);
  } catch (err) {
    console.error("Failed to start:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null && serverUrl) {
    createWindow(serverUrl);
  }
});
