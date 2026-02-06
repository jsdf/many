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

// Helper to check if a branch is a pool tmp branch
export const isTmpBranch = (branch?: string): boolean => {
  if (!branch) return false;
  const localBranch = branch.replace(/^refs\/heads\//, "");
  return localBranch.startsWith("tmp-");
};

// Helper to extract worktree name from path
export const extractWorktreeName = (worktreePath: string, repoPath: string): string => {
  const baseName = repoPath.split("/").pop() || "";
  const worktreeDirName = worktreePath.split("/").pop() || "";

  if (worktreeDirName.startsWith(baseName + "-")) {
    return worktreeDirName.substring(baseName.length + 1);
  }
  return worktreeDirName;
};

// Pool change handling options
export type ChangeHandlingOption = "stash" | "commit" | "amend" | "clean" | "cancel";

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
