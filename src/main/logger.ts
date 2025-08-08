import { app } from "electron";
import path from "path";
import { promises as fs } from "fs";

// Get user data directory for storing logs (lazily initialized)
let userDataPath: string | null = null;
let errorLogPath: string | null = null;

function initializePaths() {
  if (!userDataPath) {
    userDataPath = app.getPath("userData");
    errorLogPath = path.join(userDataPath, "electron-errors.log");
  }
}

// Queue to handle concurrent log writes
let logWriteQueue: Promise<void> = Promise.resolve();

export async function logError(error: any, source: string): Promise<void> {
  initializePaths();
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${source}: ${error.stack || error.message || error}\n`;
  
  // Chain this write after any pending writes
  logWriteQueue = logWriteQueue.then(async () => {
    try {
      await fs.mkdir(userDataPath!, { recursive: true });
      await fs.appendFile(errorLogPath!, errorMessage, 'utf8');
    } catch (logErr) {
      console.error('Failed to write error log:', logErr);
    }
  });
  
  return logWriteQueue;
}

export async function clearErrorLog(): Promise<void> {
  initializePaths();
  // Chain this after any pending writes
  logWriteQueue = logWriteQueue.then(async () => {
    try {
      await fs.mkdir(userDataPath!, { recursive: true });
      await fs.writeFile(errorLogPath!, '', 'utf8');
      const timestamp = new Date().toISOString();
      await fs.appendFile(errorLogPath!, `[${timestamp}] APP_START: Application started, error log cleared\n`, 'utf8');
    } catch (error) {
      console.error('Failed to clear error log:', error);
    }
  });
  
  return logWriteQueue;
}

export function getLogPath(): string {
  initializePaths();
  return errorLogPath!;
}