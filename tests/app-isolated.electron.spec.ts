import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, readErrorLogs, expectNoErrors, checkForErrors } from './test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Electron app starts and shows window with isolated environment', async ({ isolatedApp }) => {
  // Launch Electron app with isolated test environment
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  // Get the first window that the app opens
  const window = await electronApp.firstWindow();
  
  // Wait for the window to load
  await window.waitForLoadState('domcontentloaded');
  
  // Take a screenshot to see what's happening
  await window.screenshot({ path: 'tests/screenshots/app-startup-isolated.png' });
  
  // Check if the window title is set correctly
  const title = await window.title();
  console.log('Window title:', title);
  
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
  await window.screenshot({ path: 'tests/screenshots/app-full-isolated.png', fullPage: true });
  
  // Check if the window is visible by checking the body element
  const isVisible = await window.isVisible('body');
  expect(isVisible).toBe(true);
  
  // Print all console messages
  console.log('All console messages:', consoleMessages);
  
  // Close the app
  await electronApp.close();
  
  // Check for any errors in logs after app startup
  await expectNoErrors(isolatedApp.logPath);
});

test('Check isolated error logs after startup', async ({ isolatedApp }) => {
  // Launch app with isolated environment
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Wait for app to fully initialize
  await window.waitForTimeout(3000);
  
  await electronApp.close();
  
  // Read and analyze the logs from the isolated environment
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Found ${logs.length} log entries in isolated environment`);
  console.log(`Log path: ${isolatedApp.logPath}`);
  
  if (logs.length > 0) {
    console.log('Log entries:');
    console.log('==================');
    logs.forEach((log, i) => {
      console.log(`${i + 1}: ${log}`);
    });
    console.log('==================');
  }
  
  // Check for errors (should only have the APP_START entry)
  const { hasErrors, errorLogs } = checkForErrors(logs);
  
  if (hasErrors) {
    console.log('Error logs detected:');
    errorLogs.forEach(log => console.log(`ERROR: ${log}`));
  }
  
  // Expect no errors during normal startup
  expect(hasErrors).toBe(false);
});

test('App handles tRPC operations without errors', async ({ isolatedApp }) => {
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Wait for app initialization to complete
  await window.waitForTimeout(2000);
  
  await electronApp.close();
  
  // Check logs for any tRPC-related errors
  const logs = await readErrorLogs(isolatedApp.logPath);
  const tRPCErrors = logs.filter(log => 
    log.includes('tRPC') && 
    (log.includes('error') || log.includes('failed'))
  );
  
  console.log(`Found ${tRPCErrors.length} tRPC errors in isolated logs`);
  if (tRPCErrors.length > 0) {
    tRPCErrors.forEach(error => console.log(`tRPC ERROR: ${error}`));
  }
  
  expect(tRPCErrors.length).toBe(0);
});

test('App data is isolated between tests', async ({ isolatedApp }) => {
  // Create some test data in this isolated environment
  const testRepo = '/tmp/test-repo';
  
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  
  // Wait for app initialization
  await window.waitForTimeout(2000);
  
  await electronApp.close();
  
  // Check that this test's data is isolated
  const logs = await readErrorLogs(isolatedApp.logPath);
  expect(logs.length).toBeGreaterThan(0); // Should have APP_START log
  
  // Verify the logs are in our isolated directory
  const logPath = path.join(isolatedApp.logPath, 'electron-errors.log');
  console.log(`Isolated log path: ${logPath}`);
  
  // Each test gets its own unique data and log paths
  expect(isolatedApp.dataPath).toMatch(/many-test-/);
  expect(isolatedApp.logPath).toMatch(/many-test-/);
});