import { app, BrowserWindow, shell } from "electron";
import crypto from "crypto";

let mainWindow: BrowserWindow | null = null;
let serverUrl: string | null = null;

async function createWindow(url: string) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
    shell.openExternal(url);
    return { action: "deny" };
  });

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
