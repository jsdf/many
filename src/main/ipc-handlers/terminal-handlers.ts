import { ipcMain } from "electron";
import { TerminalManager } from "../terminal-manager";

export function registerTerminalHandlers(
  terminalManager: TerminalManager
) {
  // Basic terminal operations
  ipcMain.handle("create-terminal-session", async (_, options) => {
    return terminalManager.createTerminalSession(options);
  });

  ipcMain.handle("send-terminal-data", async (_, terminalId, data) => {
    return terminalManager.sendTerminalData(terminalId, data);
  });

  ipcMain.handle("resize-terminal", async (_, terminalId, cols, rows) => {
    terminalManager.resizeTerminal(terminalId, cols, rows);
  });

  ipcMain.handle("close-terminal", async (_, terminalId) => {
    terminalManager.closeTerminal(terminalId);
  });

  ipcMain.handle("terminal-session-exists", async (_, terminalId) => {
    return terminalManager.sessionExists(terminalId);
  });

  // Worktree terminal management is now handled by tRPC procedures
}