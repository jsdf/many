/**
 * File-based logger for the Many server/CLI.
 * Writes all log output to a rotating log file in the app data directory.
 * Also forwards to console so terminal output is preserved.
 */

import { createWriteStream, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import path from "path";
import os from "os";
import type { WriteStream } from "fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_FILES = 10;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB per file

function getLogDir(): string {
  const platform = process.platform;
  const homeDir = os.homedir();

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Logs", "many");
  } else if (platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"),
      "many",
      "logs"
    );
  } else {
    return path.join(
      process.env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"),
      "many",
      "logs"
    );
  }
}

class Logger {
  private stream: WriteStream | null = null;
  private logFilePath: string | null = null;
  private bytesWritten = 0;
  private minLevel: LogLevel = "debug";
  private initialized = false;

  /** Initialize the log file. Safe to call multiple times — only opens once. */
  private init(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const logDir = getLogDir();
      mkdirSync(logDir, { recursive: true });

      // Prune old log files
      this.pruneOldLogs(logDir);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFileName = `many-${timestamp}.log`;
      this.logFilePath = path.join(logDir, logFileName);
      this.stream = createWriteStream(this.logFilePath, { flags: "a" });

      this.stream.on("error", () => {
        // If the log file fails, just stop writing — don't crash the app
        this.stream = null;
      });
    } catch {
      // Logging should never crash the app
      this.stream = null;
    }
  }

  private pruneOldLogs(logDir: string): void {
    try {
      const files = readdirSync(logDir)
        .filter((f) => f.startsWith("many-") && f.endsWith(".log"))
        .map((f) => ({
          name: f,
          path: path.join(logDir, f),
          mtime: statSync(path.join(logDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Keep only the most recent MAX_LOG_FILES - 1 (we're about to create a new one)
      for (const file of files.slice(MAX_LOG_FILES - 1)) {
        try {
          unlinkSync(file.path);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) return;

    this.init();

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const message = args
      .map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack}`;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");

    const line = `${prefix} ${message}\n`;

    if (this.stream && this.bytesWritten < MAX_LOG_SIZE) {
      this.stream.write(line);
      this.bytesWritten += Buffer.byteLength(line, "utf8");
    }
  }

  debug(...args: unknown[]): void {
    this.write("debug", args);
  }

  info(...args: unknown[]): void {
    this.write("info", args);
  }

  warn(...args: unknown[]): void {
    this.write("warn", args);
    console.warn(...args);
  }

  error(...args: unknown[]): void {
    this.write("error", args);
    console.error(...args);
  }

  /** Get the current log file path (or null if not yet initialized) */
  getLogFilePath(): string | null {
    this.init();
    return this.logFilePath;
  }

  /** Flush and close the log stream */
  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

/** Singleton logger instance */
const logger = new Logger();
export default logger;
