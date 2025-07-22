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
  getBranches(repoPath: string): Promise<string[]>
  createWorktree(repoPath: string, branchName: string, baseBranch?: string): Promise<{ path: string }>
  getGitUsername(repoPath: string): Promise<string>
  selectFolder(): Promise<string | null>
  openDirectory(dirPath: string): Promise<boolean>
  openTerminal(dirPath: string): Promise<boolean>
  openVSCode(dirPath: string): Promise<boolean>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}