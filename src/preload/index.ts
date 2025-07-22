import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getWorktrees: (repoPath: string) => ipcRenderer.invoke('get-worktrees', repoPath),
  getBranches: (repoPath: string) => ipcRenderer.invoke('get-branches', repoPath),
  createWorktree: (repoPath: string, branchName: string, baseBranch?: string) => ipcRenderer.invoke('create-worktree', repoPath, branchName, baseBranch),
  getGitUsername: (repoPath: string) => ipcRenderer.invoke('get-git-username', repoPath),
  getSavedRepos: () => ipcRenderer.invoke('get-saved-repos'),
  saveRepo: (repoPath: string) => ipcRenderer.invoke('save-repo', repoPath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSelectedRepo: () => ipcRenderer.invoke('get-selected-repo'),
  setSelectedRepo: (repoPath: string | null) => ipcRenderer.invoke('set-selected-repo', repoPath),
  openDirectory: (dirPath: string) => ipcRenderer.invoke('open-directory', dirPath),
  openTerminal: (dirPath: string) => ipcRenderer.invoke('open-terminal', dirPath),
  openVSCode: (dirPath: string) => ipcRenderer.invoke('open-vscode', dirPath)
})