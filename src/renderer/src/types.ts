export interface Repository {
  path: string;
  name?: string;
  addedAt?: string;
}

export interface Worktree {
  path?: string;
  branch?: string;
  commit?: string;
  bare?: boolean;
}

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
}

export interface MergeOptions {
  squash: boolean;
  noFF: boolean;
  message: string;
  deleteWorktree: boolean;
  worktreePath?: string;
}

export interface GitStatus {
  modified: string[];
  not_added: string[];
  deleted: string[];
  created: string[];
  staged: string[];
  hasChanges: boolean;
  hasStaged: boolean;
}

export interface TerminalConfig {
  id: string;
  title: string;
  type: 'terminal' | 'claude';
  initialCommand?: string;
  autoFocus?: boolean;
}

export interface WorktreeTerminals {
  terminals: TerminalConfig[];
  nextTerminalId: number;
}

export interface TerminalSessionOptions {
  terminalId: string;
  workingDirectory?: string;
  cols: number;
  rows: number;
  initialCommand?: string;
  worktreePath?: string;
}

export interface ElectronAPI {
  // Terminal event listeners - must stay as IPC for real-time data streams
  onTerminalData(
    terminalId: string,
    callback: (data: string) => void
  ): (() => void) | undefined;
  onTerminalExit(
    terminalId: string,
    callback: () => void
  ): (() => void) | undefined;
  onTerminalTitle(
    terminalId: string,
    callback: (title: string) => void
  ): (() => void) | undefined;
  
  // Logging API
  logRendererError(error: any, source: string): Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
