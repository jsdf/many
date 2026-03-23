// @ts-ignore - types exist at node-pty.d.ts but aren't resolved via package.json exports
import * as pty from "@lydell/node-pty";
import os from "os";
import { promises as fs } from "fs";
import path from "path";

interface OutputBlock {
  data: string;
  timestamp: number;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

interface TerminalSession {
  ptyProcess: pty.IPty;
  worktreePath: string;
  outputBlocks: OutputBlock[];
  currentBlockData: string;
  maxBlocks: number;
  maxBlockSize: number;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<() => void>;
  logFileHandle?: fs.FileHandle;
  logBytesWritten: number;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  createSession(
    terminalId: string,
    worktreePath: string,
    cols: number,
    rows: number,
    extraEnv?: Record<string, string>,
    initialCommand?: string,
    terminalLogDir?: string | null
  ): boolean {
    // If session already exists, just return true (client is reconnecting)
    if (this.sessions.has(terminalId)) {
      return true;
    }

    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const shellArgs = process.platform === "win32" ? [] : ["-l"];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: worktreePath || os.homedir(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...extraEnv,
      } as Record<string, string>,
    });

    // Auto-run initial command after shell starts
    if (initialCommand) {
      // Small delay to let the shell initialize
      setTimeout(() => {
        ptyProcess.write(initialCommand + "\n");
      }, 500);
    }

    const session: TerminalSession = {
      ptyProcess,
      worktreePath,
      outputBlocks: [],
      currentBlockData: "",
      maxBlocks: 100,
      maxBlockSize: 1000,
      dataListeners: new Set(),
      exitListeners: new Set(),
      logBytesWritten: 0,
    };

    this.sessions.set(terminalId, session);

    // Open log file if configured
    if (terminalLogDir) {
      const label = path.basename(worktreePath).replace(/[/\\:*?"<>|]/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFileName = `${label}-${timestamp}.log`;
      const logFilePath = path.join(terminalLogDir, logFileName);
      fs.mkdir(terminalLogDir, { recursive: true })
        .then(() => fs.open(logFilePath, "a"))
        .then((handle) => {
          session.logFileHandle = handle;
        })
        .catch((err) => {
          console.error(`Failed to open terminal log file ${logFilePath}:`, err);
        });
    }

    ptyProcess.onData((data: string) => {
      this.appendOutput(session, data);
      if (session.logFileHandle && session.logBytesWritten < MAX_LOG_BYTES) {
        const bytes = Buffer.byteLength(data, "utf8");
        session.logBytesWritten += bytes;
        session.logFileHandle.write(data).catch(() => {});
        if (session.logBytesWritten >= MAX_LOG_BYTES) {
          session.logFileHandle.write("\n[log truncated at 10MB]\n").catch(() => {});
        }
      }
      for (const listener of session.dataListeners) {
        listener(data);
      }
    });

    ptyProcess.onExit(() => {
      if (session.logFileHandle) {
        session.logFileHandle.close().catch(() => {});
        session.logFileHandle = undefined;
      }
      for (const listener of session.exitListeners) {
        listener();
      }
      this.sessions.delete(terminalId);
    });

    return false; // New session created
  }

  sendData(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.ptyProcess.write(data);
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      try {
        session.ptyProcess.resize(cols, rows);
      } catch (err) {
        // PTY may have already exited
      }
    }
  }

  closeSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      try {
        session.ptyProcess.kill();
      } catch (err) {
        // Already dead
      }
      if (session.logFileHandle) {
        session.logFileHandle.close().catch(() => {});
        session.logFileHandle = undefined;
      }
      this.sessions.delete(terminalId);
    }
  }

  sessionExists(terminalId: string): boolean {
    return this.sessions.has(terminalId);
  }

  getSessionPid(terminalId: string): number | null {
    const session = this.sessions.get(terminalId);
    return session ? session.ptyProcess.pid : null;
  }

  getSessionsForWorktree(worktreePath: string): string[] {
    const ids: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.worktreePath === worktreePath) {
        ids.push(id);
      }
    }
    return ids;
  }

  addDataListener(terminalId: string, listener: (data: string) => void): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.dataListeners.add(listener);
    }
  }

  removeDataListener(terminalId: string, listener: (data: string) => void): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.dataListeners.delete(listener);
    }
  }

  addExitListener(terminalId: string, listener: () => void): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.exitListeners.add(listener);
    }
  }

  removeExitListener(terminalId: string, listener: () => void): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.exitListeners.delete(listener);
    }
  }

  getBufferedOutput(terminalId: string): string {
    const session = this.sessions.get(terminalId);
    if (!session) return "";
    let output = "";
    for (const block of session.outputBlocks) {
      output += block.data;
    }
    output += session.currentBlockData;
    return output;
  }

  cleanupWorktree(worktreePath: string): void {
    const ids = this.getSessionsForWorktree(worktreePath);
    for (const id of ids) {
      this.closeSession(id);
    }
  }

  /**
   * Save buffered output from all active sessions to log files.
   * Returns metadata for each saved session so callers can register task records.
   */
  async saveAllSessionLogs(logDir: string): Promise<Array<{
    terminalId: string;
    worktreePath: string;
    logFile: string;
  }>> {
    await fs.mkdir(logDir, { recursive: true });
    const results: Array<{ terminalId: string; worktreePath: string; logFile: string }> = [];

    for (const [id, session] of this.sessions) {
      const output = this.getBufferedOutput(id);
      if (!output) continue;

      const label = path.basename(session.worktreePath).replace(/[/\\:*?"<>|]/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFileName = `terminal-${label}-${timestamp}.log`;
      const logFile = path.join(logDir, logFileName);

      try {
        await fs.writeFile(logFile, output);
        results.push({ terminalId: id, worktreePath: session.worktreePath, logFile });
      } catch (err) {
        console.error(`Failed to save terminal log for ${id}:`, err);
      }
    }

    return results;
  }

  cleanup(): void {
    for (const [id, session] of this.sessions) {
      try {
        session.ptyProcess.kill();
      } catch (err) {
        // Ignore
      }
    }
    this.sessions.clear();
  }

  private appendOutput(session: TerminalSession, data: string): void {
    session.currentBlockData += data;

    if (session.currentBlockData.length >= session.maxBlockSize) {
      session.outputBlocks.push({
        data: session.currentBlockData,
        timestamp: Date.now(),
      });
      session.currentBlockData = "";

      while (session.outputBlocks.length > session.maxBlocks) {
        session.outputBlocks.shift();
      }
    }
  }
}
