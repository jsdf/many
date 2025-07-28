// Type definitions for the main process

export interface Repository {
  path: string;
  name: string;
  addedAt: string;
}

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
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

export interface AppData {
  repositories: Repository[];
  repositoryConfigs: Record<string, RepositoryConfig>;
  selectedRepo: string | null;
  recentWorktrees: Record<string, string>; // repoPath -> worktreePath
  windowBounds: { width: number; height: number; x?: number; y?: number };
  worktreeTerminals: Record<string, WorktreeTerminals>; // worktreePath -> terminal configs
}