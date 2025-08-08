import { contextBridge, ipcRenderer } from "electron";

// Expose electronTRPC for electron-trpc/renderer
contextBridge.exposeInMainWorld("electronTRPC", {
  sendMessage: (data: any) => ipcRenderer.send('electron-trpc', data),
  onMessage: (callback: (data: any) => void) => {
    ipcRenderer.on('electron-trpc', (_event, data) => callback(data));
  },
});

contextBridge.exposeInMainWorld("electronAPI", {
  // Git and worktree APIs
  getWorktrees: (repoPath: string) =>
    ipcRenderer.invoke("get-worktrees", repoPath),
  getBranches: (repoPath: string) =>
    ipcRenderer.invoke("get-branches", repoPath),
  createWorktree: (repoPath: string, branchName: string, baseBranch?: string) =>
    ipcRenderer.invoke("create-worktree", repoPath, branchName, baseBranch),
  getGitUsername: (repoPath: string) =>
    ipcRenderer.invoke("get-git-username", repoPath),
  getSavedRepos: () => ipcRenderer.invoke("get-saved-repos"),
  saveRepo: (repoPath: string) => ipcRenderer.invoke("save-repo", repoPath),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  getSelectedRepo: () => ipcRenderer.invoke("get-selected-repo"),
  setSelectedRepo: (repoPath: string | null) =>
    ipcRenderer.invoke("set-selected-repo", repoPath),

  // Terminal APIs
  createTerminalSession: (options: {
    terminalId: string;
    workingDirectory?: string;
    cols: number;
    rows: number;
    initialCommand?: string;
    worktreePath?: string;
  }) => ipcRenderer.invoke("create-terminal-session", options),

  sendTerminalData: (terminalId: string, data: string) =>
    ipcRenderer.invoke("send-terminal-data", terminalId, data),

  resizeTerminal: (terminalId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("resize-terminal", terminalId, cols, rows),

  closeTerminal: (terminalId: string) =>
    ipcRenderer.invoke("close-terminal", terminalId),

  terminalSessionExists: (terminalId: string) =>
    ipcRenderer.invoke("terminal-session-exists", terminalId),

  // Worktree terminal management
  getWorktreeTerminals: (worktreePath: string) =>
    ipcRenderer.invoke("get-worktree-terminals", worktreePath),
  saveWorktreeTerminals: (worktreePath: string, terminalConfig: any) =>
    ipcRenderer.invoke("save-worktree-terminals", worktreePath, terminalConfig),
  cleanupWorktreeTerminals: (worktreePath: string) =>
    ipcRenderer.invoke("cleanup-worktree-terminals", worktreePath),

  // Terminal event listeners
  onTerminalData: (terminalId: string, callback: (data: string) => void) => {
    const channel = `terminal-data-${terminalId}`;
    const handler = (_event: any, data: string) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onTerminalExit: (terminalId: string, callback: () => void) => {
    const channel = `terminal-exit-${terminalId}`;
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  onTerminalTitle: (terminalId: string, callback: (title: string) => void) => {
    const channel = `terminal-title-${terminalId}`;
    const handler = (_event: any, title: string) => callback(title);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Quick Actions APIs
  openInFileManager: (folderPath: string) =>
    ipcRenderer.invoke("open-in-file-manager", folderPath),
  openInEditor: (folderPath: string) =>
    ipcRenderer.invoke("open-in-editor", folderPath),
  openInTerminal: (folderPath: string) =>
    ipcRenderer.invoke("open-in-terminal", folderPath),
  getRepoConfig: (repoPath: string) =>
    ipcRenderer.invoke("get-repo-config", repoPath),
  saveRepoConfig: (repoPath: string, config: any) =>
    ipcRenderer.invoke("save-repo-config", repoPath, config),
  archiveWorktree: (repoPath: string, worktreePath: string, force?: boolean) =>
    ipcRenderer.invoke("archive-worktree", repoPath, worktreePath, force),
  checkBranchMerged: (repoPath: string, branchName: string) =>
    ipcRenderer.invoke("check-branch-merged", repoPath, branchName),
  mergeWorktree: (
    repoPath: string,
    fromBranch: string,
    toBranch: string,
    options: any
  ) =>
    ipcRenderer.invoke(
      "merge-worktree",
      repoPath,
      fromBranch,
      toBranch,
      options
    ),
  rebaseWorktree: (
    worktreePath: string,
    fromBranch: string,
    ontoBranch: string
  ) =>
    ipcRenderer.invoke("rebase-worktree", worktreePath, fromBranch, ontoBranch),
  getWorktreeStatus: (worktreePath: string) =>
    ipcRenderer.invoke("get-worktree-status", worktreePath),
  getCommitLog: (worktreePath: string, baseBranch: string) =>
    ipcRenderer.invoke("get-commit-log", worktreePath, baseBranch),
  getRecentWorktree: (repoPath: string) =>
    ipcRenderer.invoke("get-recent-worktree", repoPath),
  setRecentWorktree: (repoPath: string, worktreePath: string) =>
    ipcRenderer.invoke("set-recent-worktree", repoPath, worktreePath),
  
  // Logging API
  logRendererError: (error: any, source: string) =>
    ipcRenderer.invoke("log-renderer-error", error, source),
});
