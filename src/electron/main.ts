import { app, BrowserWindow, Menu, MenuItem, shell, dialog } from "electron";
import crypto from "crypto";
import { loadAppData, withAppData } from "../cli/config.js";
import type { WebServerResult } from "../web/server.js";

let mainWindow: BrowserWindow | null = null;
let serverUrl: string | null = null;
let webServer: WebServerResult | null = null;
let isQuitting = false;
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

  // Provide a native right-click menu for editable fields and selected text.
  // The app's own React context menus (list rows, tabs) handle their own areas;
  // this fills in the "dead" right-clicks everywhere else with copy/paste.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = new Menu();

    if (params.isEditable) {
      menu.append(new MenuItem({ role: "cut", enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: "copy", enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: "paste", enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ type: "separator" }));
      menu.append(new MenuItem({ role: "selectAll", enabled: params.editFlags.canSelectAll }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: "copy" }));
    } else {
      return;
    }

    if (mainWindow) menu.popup({ window: mainWindow });
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
    // handleSignals:false — we drive shutdown from the before-quit handler so we
    // can show a native dialog before killing any running terminals.
    const result = await startWebServer({ port: 0, open: false, token, handleSignals: false });
    webServer = result;
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

// PTYs live in the detached terminal daemon and survive this app quitting. Ask
// the user whether to also shut them down when any are still running; otherwise
// shut the daemon down silently (nothing to lose).
app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  void (async () => {
    let killTerminals = false;
    try {
      const count = (await webServer?.getRunningTerminalCount()) ?? 0;
      if (count > 0) {
        const { response } = await dialog.showMessageBox({
          type: "question",
          buttons: ["Leave Running", "Shut Down"],
          defaultId: 0,
          cancelId: 0,
          message: `${count} background session${count === 1 ? " is" : "s are"} still running.`,
          detail:
            "Leave them running in the background (the app can reconnect next launch), or shut them down now?",
        });
        killTerminals = response === 1;
      }
    } catch {
      // daemon unreachable; nothing to prompt about
    }
    try {
      await webServer?.shutdown({ killTerminals });
    } catch {
      // best-effort
    }
    app.quit();
  })();
});

app.on("activate", () => {
  if (mainWindow === null && serverUrl) {
    createWindow(serverUrl);
  }
});
