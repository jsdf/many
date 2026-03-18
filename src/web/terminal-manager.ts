// @ts-ignore - types exist at node-pty.d.ts but aren't resolved via package.json exports
import * as pty from "@lydell/node-pty";
import os from "os";

interface OutputBlock {
  data: string;
  timestamp: number;
}

interface TerminalSession {
  ptyProcess: pty.IPty;
  worktreePath: string;
  outputBlocks: OutputBlock[];
  currentBlockData: string;
  maxBlocks: number;
  maxBlockSize: number;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<() => void>;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  createSession(
    terminalId: string,
    worktreePath: string,
    cols: number,
    rows: number,
    extraEnv?: Record<string, string>,
    initialCommand?: string
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
    };

    this.sessions.set(terminalId, session);

    ptyProcess.onData((data: string) => {
      this.appendOutput(session, data);
      for (const listener of session.dataListeners) {
        listener(data);
      }
    });

    ptyProcess.onExit(() => {
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
      this.sessions.delete(terminalId);
    }
  }

  sessionExists(terminalId: string): boolean {
    return this.sessions.has(terminalId);
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
