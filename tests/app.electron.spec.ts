import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Electron app starts and shows window', async () => {
  // Launch Electron app - pass the path to the main process (Vite output)
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });

  // Get the first window that the app opens
  const window = await electronApp.firstWindow();
  
  // Wait for the window to load
  await window.waitForLoadState('domcontentloaded');
  
  // Take a screenshot to see what's happening
  await window.screenshot({ path: 'tests/screenshots/app-startup.png' });
  
  // Check if the window title is set correctly
  const title = await window.title();
  console.log('Window title:', title);
  
  // Get app information
  const appPath = await electronApp.evaluate(async ({ app }) => {
    return app.getAppPath();
  });
  console.log('App path:', appPath);
  
  // Check for any errors in the console
  const consoleMessages: string[] = [];
  window.on('console', msg => {
    const message = `${msg.type()}: ${msg.text()}`;
    consoleMessages.push(message);
    console.log(`Console ${message}`);
  });
  
  // Wait a bit to capture any initial console messages and let app fully load
  await window.waitForTimeout(3000);
  
  // Take another screenshot of the full app
  await window.screenshot({ path: 'tests/screenshots/app-full.png', fullPage: true });
  
  // Check if the window is visible by checking the body element
  const isVisible = await window.isVisible('body');
  expect(isVisible).toBe(true);
  
  // Print all console messages
  console.log('All console messages:', consoleMessages);
  
  // Close the app
  await electronApp.close();
});

test('Check error logs after startup', async () => {
  // Launch app, let it start, then check logs
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Wait for app to fully initialize
  await window.waitForTimeout(3000);
  
  await electronApp.close();
  
  // Now check the error logs
  const fs = await import('fs');
  const os = await import('os');
  
  const userDataPath = process.platform === 'darwin' 
    ? path.join(os.homedir(), 'Library', 'Application Support', 'many')
    : process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'many')
    : path.join(os.homedir(), '.config', 'many');
  
  const logPath = path.join(userDataPath, 'electron-errors.log');
  
  console.log('Checking log path:', logPath);
  
  try {
    const logContent = fs.readFileSync(logPath, 'utf8');
    console.log('Error log content:');
    console.log('==================');
    console.log(logContent);
    console.log('==================');
  } catch (error) {
    console.log('No error log found or unable to read:', error);
  }
});