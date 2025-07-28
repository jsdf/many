import { ipcMain } from "electron";
import * as externalActions from "../external-actions";

export function registerExternalActionHandlers() {
  // Quick Actions
  ipcMain.handle("open-in-file-manager", async (_, folderPath) => {
    return externalActions.openInFileManager(folderPath);
  });

  ipcMain.handle("open-in-editor", async (_, folderPath) => {
    return externalActions.openInEditor(folderPath);
  });

  ipcMain.handle("open-in-terminal", async (_, folderPath) => {
    return externalActions.openInTerminal(folderPath);
  });

  // Directory operations
  ipcMain.handle("open-directory", async (event, dirPath) => {
    return externalActions.openDirectory(dirPath);
  });

  ipcMain.handle("open-terminal", async (event, dirPath) => {
    return externalActions.openTerminalInDirectory(dirPath);
  });

  ipcMain.handle("open-vscode", async (event, dirPath) => {
    return externalActions.openVSCode(dirPath);
  });
}