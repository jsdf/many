import { BrowserWindow } from "electron";
import * as pty from "@lydell/node-pty";
import os from "os";
import path from "path";

export interface TerminalSession {
  ptyProcess: pty.IPty;
  workingDirectory: string;
}

export interface TerminalSessionOptions {
  terminalId: string;
  workingDirectory?: string;
  cols: number;
  rows: number;
  initialCommand?: string;
}

export class TerminalManager {
  private terminalSessions = new Map<string, TerminalSession>();
  private mainWindow: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  setMainWindow(mainWindow: BrowserWindow | null) {
    this.mainWindow = mainWindow;
  }

  async createTerminalSession(options: TerminalSessionOptions): Promise<{ terminalId: string }> {
    try {
      const { terminalId, workingDirectory, cols, rows, initialCommand } = options;
      const cwd = workingDirectory || os.homedir();

      // Determine shell
      const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
      const shellArgs = process.platform === 'win32' ? [] : ['-l']; // -l for login shell

      // Create PTY process with clean environment
      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd,
        env: {
          // Core system variables
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          SHELL: process.env.SHELL,
          TERM: 'xterm-256color',
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL,
          
          // macOS specific
          TMPDIR: process.env.TMPDIR,
          
          // Common development tools
          EDITOR: process.env.EDITOR,
          PAGER: process.env.PAGER,
          
          // Git configuration - pass through all Git-related environment variables
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
          GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
          
          // Excludes npm_config_prefix and other Electron/Node variables
        }
      });

      // Create terminal session
      const session: TerminalSession = {
        ptyProcess,
        workingDirectory: cwd
      };

      this.terminalSessions.set(terminalId, session);

      // Handle PTY data
      ptyProcess.onData((data) => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send(`terminal-data-${terminalId}`, data);
        }
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`Terminal ${terminalId} exited with code ${exitCode}, signal ${signal}`);
        this.terminalSessions.delete(terminalId);
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send(`terminal-exit-${terminalId}`);
        }
      });

      // Send initial command if provided
      if (initialCommand) {
        setTimeout(() => {
          const currentSession = this.terminalSessions.get(terminalId);
          if (currentSession) {
            currentSession.ptyProcess.write(initialCommand + '\r');
          }
        }, 100);
      }

      return { terminalId };
    } catch (error) {
      throw new Error(`Failed to create terminal session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendTerminalData(terminalId: string, data: string): Promise<void> {
    try {
      const session = this.terminalSessions.get(terminalId);
      if (!session) {
        return;
      }

      // Send data directly to PTY process
      session.ptyProcess.write(data);
      
    } catch (error) {
      console.error(`Failed to send data to terminal ${terminalId}:`, error);
    }
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    try {
      const session = this.terminalSessions.get(terminalId);
      if (session) {
        session.ptyProcess.resize(cols, rows);
      }
    } catch (error) {
      console.error(`Failed to resize terminal ${terminalId}:`, error);
    }
  }

  closeTerminal(terminalId: string): void {
    try {
      const session = this.terminalSessions.get(terminalId);
      if (session) {
        session.ptyProcess.kill();
        this.terminalSessions.delete(terminalId);
      }
    } catch (error) {
      console.error(`Failed to close terminal ${terminalId}:`, error);
    }
  }

  cleanup(): void {
    // Kill all PTY processes before clearing
    for (const [terminalId, session] of this.terminalSessions) {
      try {
        session.ptyProcess.kill();
      } catch (error) {
        console.error(`Error killing PTY process for terminal ${terminalId}:`, error);
      }
    }
    this.terminalSessions.clear();
  }
}