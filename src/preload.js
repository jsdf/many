const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getWorktrees: (repoPath) => ipcRenderer.invoke('get-worktrees', repoPath),
  createWorktree: (repoPath, branchName, prompt) => ipcRenderer.invoke('create-worktree', repoPath, branchName, prompt),
  getGitUsername: (repoPath) => ipcRenderer.invoke('get-git-username', repoPath),
  getSavedRepos: () => ipcRenderer.invoke('get-saved-repos'),
  saveRepo: (repoPath) => ipcRenderer.invoke('save-repo', repoPath),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSelectedRepo: () => ipcRenderer.invoke('get-selected-repo'),
  setSelectedRepo: (repoPath) => ipcRenderer.invoke('set-selected-repo', repoPath)
});