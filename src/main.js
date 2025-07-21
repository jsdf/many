const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const simpleGit = require('simple-git');

let mainWindow;

// Get user data directory for storing app data
const userDataPath = app.getPath('userData');
const dataFilePath = path.join(userDataPath, 'app-data.json');

// Default app data structure
const defaultAppData = {
  repositories: [],
  selectedRepo: null,
  windowBounds: { width: 1200, height: 800 }
};

// Load app data from disk
async function loadAppData() {
  try {
    const data = await fs.readFile(dataFilePath, 'utf8');
    return { ...defaultAppData, ...JSON.parse(data) };
  } catch (error) {
    // File doesn't exist or is invalid, return defaults
    return defaultAppData;
  }
}

// Save app data to disk
async function saveAppData(data) {
  try {
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save app data:', error);
  }
}

async function createWindow() {
  const appData = await loadAppData();
  
  mainWindow = new BrowserWindow({
    width: appData.windowBounds.width,
    height: appData.windowBounds.height,
    x: appData.windowBounds.x,
    y: appData.windowBounds.y,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Save window bounds when moved or resized
  mainWindow.on('moved', saveWindowBounds);
  mainWindow.on('resized', saveWindowBounds);

  async function saveWindowBounds() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      const currentData = await loadAppData();
      currentData.windowBounds = bounds;
      await saveAppData(currentData);
    }
  }

  mainWindow.loadFile('src/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('get-worktrees', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const worktrees = await git.raw(['worktree', 'list', '--porcelain']);
    
    const parsed = [];
    const lines = worktrees.split('\n');
    let current = {};
    
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current.path) parsed.push(current);
        current = { path: line.substring(9) };
      } else if (line.startsWith('HEAD ')) {
        current.commit = line.substring(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.substring(7);
      } else if (line.startsWith('bare')) {
        current.bare = true;
      }
    }
    if (current.path) parsed.push(current);
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to get worktrees: ${error.message}`);
  }
});

ipcMain.handle('create-worktree', async (event, repoPath, branchName, prompt) => {
  try {
    const git = simpleGit(repoPath);
    
    // Generate branch name from prompt
    const sanitizedPrompt = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    
    const fullBranchName = `${branchName}/${sanitizedPrompt}`;
    const worktreePath = path.join(repoPath, '..', `${path.basename(repoPath)}-${sanitizedPrompt}`);
    
    // Create new branch and worktree
    await git.checkoutLocalBranch(fullBranchName);
    await git.raw(['worktree', 'add', worktreePath, fullBranchName]);
    
    return { path: worktreePath, branch: fullBranchName };
  } catch (error) {
    throw new Error(`Failed to create worktree: ${error.message}`);
  }
});

ipcMain.handle('get-git-username', async (event, repoPath) => {
  try {
    const git = simpleGit(repoPath);
    const config = await git.listConfig();
    return config.all['user.name'] || 'user';
  } catch (error) {
    return 'user';
  }
});

ipcMain.handle('get-saved-repos', async () => {
  try {
    const appData = await loadAppData();
    return appData.repositories;
  } catch (error) {
    console.error('Failed to get saved repos:', error);
    return [];
  }
});

ipcMain.handle('save-repo', async (event, repoPath) => {
  try {
    const appData = await loadAppData();
    
    // Check if repo already exists
    const exists = appData.repositories.some(repo => repo.path === repoPath);
    if (!exists) {
      // Get repo name from path
      const repoName = path.basename(repoPath);
      appData.repositories.push({
        path: repoPath,
        name: repoName,
        addedAt: new Date().toISOString()
      });
      await saveAppData(appData);
    }
    
    return true;
  } catch (error) {
    console.error('Failed to save repo:', error);
    throw new Error(`Failed to save repository: ${error.message}`);
  }
});

ipcMain.handle('get-selected-repo', async () => {
  try {
    const appData = await loadAppData();
    return appData.selectedRepo;
  } catch (error) {
    console.error('Failed to get selected repo:', error);
    return null;
  }
});

ipcMain.handle('set-selected-repo', async (event, repoPath) => {
  try {
    const appData = await loadAppData();
    appData.selectedRepo = repoPath;
    await saveAppData(appData);
    return true;
  } catch (error) {
    console.error('Failed to set selected repo:', error);
    throw new Error(`Failed to save selected repository: ${error.message}`);
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Git Repository Folder'
  });
  
  if (result.canceled) {
    return null;
  }
  
  return result.filePaths[0];
});