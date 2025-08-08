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
  getSavedRepos(): Promise<Repository[]>;
  saveRepo(path: string): Promise<void>;
  getSelectedRepo(): Promise<string | null>;
  setSelectedRepo(path: string | null): Promise<void>;
  getWorktrees(repoPath: string): Promise<Worktree[]>;
  getBranches(repoPath: string): Promise<string[]>;
  createWorktree(
    repoPath: string,
    branchName: string,
    baseBranch?: string
  ): Promise<{ path: string; branch: string; initCommand?: string | null }>;
  getGitUsername(repoPath: string): Promise<string>;
  selectFolder(): Promise<string | null>;
  openInFileManager(folderPath: string): Promise<boolean>;
  openInTerminal(folderPath: string): Promise<boolean>;
  openInEditor(folderPath: string): Promise<boolean>;
  getRepoConfig(repoPath: string): Promise<RepositoryConfig>;
  saveRepoConfig(repoPath: string, config: RepositoryConfig): Promise<boolean>;
  archiveWorktree(
    repoPath: string,
    worktreePath: string,
    force?: boolean
  ): Promise<boolean>;
  checkBranchMerged(
    repoPath: string,
    branchName: string
  ): Promise<{
    isFullyMerged: boolean;
    mainBranch: string;
    branchName: string;
    error?: string;
  }>;
  mergeWorktree(
    repoPath: string,
    fromBranch: string,
    toBranch: string,
    options: MergeOptions
  ): Promise<boolean>;
  rebaseWorktree(
    worktreePath: string,
    fromBranch: string,
    ontoBranch: string
  ): Promise<boolean>;
  getWorktreeStatus(worktreePath: string): Promise<GitStatus>;
  getCommitLog(worktreePath: string, baseBranch: string): Promise<string>;
  getRecentWorktree(repoPath: string): Promise<string | null>;
  setRecentWorktree(repoPath: string, worktreePath: string): Promise<boolean>;

  // Terminal-related APIs
  createTerminalSession(
    options: TerminalSessionOptions
  ): Promise<{ terminalId: string }>;
  sendTerminalData(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  terminalSessionExists(terminalId: string): Promise<boolean>;
  
  // Worktree terminal management
  getWorktreeTerminals(worktreePath: string): Promise<WorktreeTerminals>;
  saveWorktreeTerminals(worktreePath: string, terminalConfig: WorktreeTerminals): Promise<boolean>;
  cleanupWorktreeTerminals(worktreePath: string): Promise<boolean>;
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
