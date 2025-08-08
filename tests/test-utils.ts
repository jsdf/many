import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { test as base } from "@playwright/test";

// Test fixture types
export interface TestFixtures {
  isolatedApp: {
    dataPath: string;
    logPath: string;
    cleanup: () => Promise<void>;
  };
}

// Create isolated test environment
export async function createIsolatedTestEnv(): Promise<{
  dataPath: string;
  logPath: string;
  cleanup: () => Promise<void>;
}> {
  const testId = Math.random().toString(36).substring(7);
  const baseDir = path.join(os.tmpdir(), `many-test-${testId}`);
  const dataPath = path.join(baseDir, "data");
  const logPath = path.join(baseDir, "logs");
  
  // Create directories
  await fs.mkdir(dataPath, { recursive: true });
  await fs.mkdir(logPath, { recursive: true });
  
  const cleanup = async () => {
    try {
      await fs.rm(baseDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to cleanup test directory ${baseDir}:`, error);
    }
  };
  
  return { dataPath, logPath, cleanup };
}

// Read error logs from the test log path
export async function readErrorLogs(logPath: string): Promise<string[]> {
  const logFilePath = path.join(logPath, "electron-errors.log");
  try {
    const content = await fs.readFile(logFilePath, "utf8");
    return content.trim().split("\n").filter(line => line.length > 0);
  } catch (error) {
    // Log file doesn't exist or is empty
    return [];
  }
}

// Parse error log entry
export interface LogEntry {
  timestamp: string;
  source: string;
  message: string;
  raw: string;
}

export function parseLogEntry(logLine: string): LogEntry | null {
  const match = logLine.match(/^\[([^\]]+)\] ([^:]+): (.+)$/);
  if (!match) {
    return null;
  }
  
  return {
    timestamp: match[1],
    source: match[2],
    message: match[3],
    raw: logLine
  };
}

// Check for specific error patterns in logs
export function checkForErrors(logs: string[], patterns: string[] = []): {
  hasErrors: boolean;
  errorLogs: string[];
  matchedPatterns: string[];
} {
  const errorLogs: string[] = [];
  const matchedPatterns: string[] = [];
  
  logs.forEach(log => {
    const entry = parseLogEntry(log);
    if (!entry) return;
    
    // Skip expected app start messages
    if (entry.source === "APP_START") return;
    
    // Check for general error indicators
    const isError = entry.source.includes("ERROR") || 
                   entry.source.includes("CRASH") || 
                   entry.source.includes("EXCEPTION") ||
                   entry.message.toLowerCase().includes("error") ||
                   entry.message.toLowerCase().includes("failed");
    
    if (isError) {
      errorLogs.push(log);
    }
    
    // Check for specific patterns
    patterns.forEach(pattern => {
      if (log.includes(pattern)) {
        matchedPatterns.push(pattern);
      }
    });
  });
  
  return {
    hasErrors: errorLogs.length > 0,
    errorLogs,
    matchedPatterns
  };
}

// Test fixture with isolated environment
export const test = base.extend<TestFixtures>({
  isolatedApp: async ({}, use) => {
    const testEnv = await createIsolatedTestEnv();
    
    // Set environment variables for the Electron process
    process.env.TEST_DATA_PATH = testEnv.dataPath;
    process.env.TEST_LOG_PATH = testEnv.logPath;
    
    await use(testEnv);
    
    // Cleanup
    delete process.env.TEST_DATA_PATH;
    delete process.env.TEST_LOG_PATH;
    await testEnv.cleanup();
  }
});

// Helper to assert no errors in logs
export async function expectNoErrors(logPath: string, allowedPatterns: string[] = []) {
  const logs = await readErrorLogs(logPath);
  const { hasErrors, errorLogs, matchedPatterns } = checkForErrors(logs, allowedPatterns);
  
  if (hasErrors) {
    const errorMessage = `Found ${errorLogs.length} error(s) in logs:\n${errorLogs.join("\n")}`;
    throw new Error(errorMessage);
  }
  
  if (matchedPatterns.length > 0) {
    const patternMessage = `Found disallowed patterns in logs: ${matchedPatterns.join(", ")}`;
    throw new Error(patternMessage);
  }
}

// Helper to wait for specific log entries
export async function waitForLogEntry(
  logPath: string, 
  pattern: string, 
  timeoutMs: number = 5000
): Promise<LogEntry | null> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const logs = await readErrorLogs(logPath);
    
    for (const log of logs) {
      if (log.includes(pattern)) {
        return parseLogEntry(log);
      }
    }
    
    // Wait a bit before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return null;
}