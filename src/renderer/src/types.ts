export interface Repository {
  path: string
  name?: string
  addedAt?: string
}

export interface Worktree {
  path: string
  branch?: string
}

export interface ElectronAPI {
  getSavedRepos(): Promise<Repository[]>
  saveRepo(path: string): Promise<void>
  getSelectedRepo(): Promise<string | null>
  setSelectedRepo(path: string | null): Promise<void>
  getWorktrees(repoPath: string): Promise<Worktree[]>
  createWorktree(repoPath: string, branchName: string): Promise<{ path: string }>
  getGitUsername(repoPath: string): Promise<string>
  selectFolder(): Promise<string | null>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}