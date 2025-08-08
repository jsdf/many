import { app } from "electron";
import path from "path";
import { AppData } from "./types";

// Configuration for overriding paths during testing
interface AppConfig {
  dataPath?: string;
  logPath?: string;
}

let config: AppConfig = {};

// Set configuration (primarily for testing)
export function setAppConfig(newConfig: AppConfig): void {
  config = { ...config, ...newConfig };
}

// Reset configuration to defaults
export function resetAppConfig(): void {
  config = {};
}

// Get the data directory path (with test override)
export function getDataPath(): string {
  if (config.dataPath) {
    return config.dataPath;
  }
  return app.getPath("userData");
}

// Get the log directory path (with test override)  
export function getLogPath(): string {
  if (config.logPath) {
    return config.logPath;
  }
  return app.getPath("userData");
}

// Get the full data file path
export function getDataFilePath(): string {
  return path.join(getDataPath(), "app-data.json");
}

// Get the full log file path
export function getLogFilePath(): string {
  return path.join(getLogPath(), "electron-errors.log");
}

// Default app data structure
export const defaultAppData: AppData = {
  repositories: [],
  repositoryConfigs: {},
  selectedRepo: null,
  recentWorktrees: {},
  windowBounds: { width: 1200, height: 800 },
  worktreeTerminals: {},
};

// Environment variables for test configuration
export function loadConfigFromEnv(): void {
  const testDataPath = process.env.TEST_DATA_PATH;
  const testLogPath = process.env.TEST_LOG_PATH;
  
  if (testDataPath || testLogPath) {
    setAppConfig({
      dataPath: testDataPath,
      logPath: testLogPath
    });
  }
}