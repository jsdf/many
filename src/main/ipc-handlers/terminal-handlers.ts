import { ipcMain } from "electron";
import { TerminalManager } from "../terminal-manager";
import { AppData } from "../types";

export function registerTerminalHandlers(
  terminalManager: TerminalManager,
  loadAppData: () => Promise<AppData>,
  saveAppData: (data: AppData) => Promise<void>
) {
  // Basic terminal operations
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
}