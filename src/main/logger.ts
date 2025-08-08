import { promises as fs } from "fs";
import { getLogPath, getLogFilePath } from "./config";

// Cached log path
let errorLogPath: string | null = null;

function initializePaths() {
  if (!errorLogPath) {
    errorLogPath = getLogFilePath();
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
      const logDir = getLogPath();
      await fs.mkdir(logDir, { recursive: true });
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
      const logDir = getLogPath();
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(errorLogPath!, '', 'utf8');
      const timestamp = new Date().toISOString();
      await fs.appendFile(errorLogPath!, `[${timestamp}] APP_START: Application started, error log cleared\n`, 'utf8');
    } catch (error) {
      console.error('Failed to clear error log:', error);
    }
  });
  
  return logWriteQueue;
}

export function getErrorLogPath(): string {
  initializePaths();
  return errorLogPath!;
}