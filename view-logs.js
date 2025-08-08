#!/usr/bin/env node

import path from 'path';
import os from 'os';
import fs from 'fs';

// Determine user data path for different platforms
const userDataPath = process.platform === 'darwin' 
  ? path.join(os.homedir(), 'Library', 'Application Support', 'many')
  : process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'many')
  : path.join(os.homedir(), '.config', 'many');

const logPath = path.join(userDataPath, 'electron-errors.log');

console.log('Electron error log location:', logPath);
console.log('=====================================\n');

try {
  const logContent = fs.readFileSync(logPath, 'utf8');
  if (logContent.trim()) {
    console.log(logContent);
  } else {
    console.log('Error log is empty.');
  }
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('No error log found yet. Run the app to generate logs.');
  } else {
    console.log('Unable to read error log:', error.message);
  }
}