"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  getWorktrees: (repoPath) => electron.ipcRenderer.invoke("get-worktrees", repoPath),
  createWorktree: (repoPath, branchName) => electron.ipcRenderer.invoke("create-worktree", repoPath, branchName),
  getGitUsername: (repoPath) => electron.ipcRenderer.invoke("get-git-username", repoPath),
  getSavedRepos: () => electron.ipcRenderer.invoke("get-saved-repos"),
  saveRepo: (repoPath) => electron.ipcRenderer.invoke("save-repo", repoPath),
  selectFolder: () => electron.ipcRenderer.invoke("select-folder"),
  getSelectedRepo: () => electron.ipcRenderer.invoke("get-selected-repo"),
  setSelectedRepo: (repoPath) => electron.ipcRenderer.invoke("set-selected-repo", repoPath)
});
