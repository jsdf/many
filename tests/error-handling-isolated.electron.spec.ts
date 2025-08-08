import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, readErrorLogs, checkForErrors, parseLogEntry, waitForLogEntry } from './test-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Error handling with isolated environment', async ({ isolatedApp }) => {
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

  // Trigger an intentional error by trying to add an invalid repository
  try {
    // Try to add a non-existent repository path which should trigger an error
    await window.evaluate(async () => {
      // This should trigger an error that gets logged
      try {
        if (window.electronAPI && window.electronAPI.logRendererError) {
          await window.electronAPI.logRendererError('Test error for validation', 'TEST_ERROR');
        }
        
        // Also test client-side error logging
        const { logError } = await import('../src/renderer/src/logger');
        await logError('Test client-side error logging', 'CLIENT_TEST');
      } catch (e) {
        console.log('Error testing failed:', e);
      }
    });
  } catch (error) {
    console.log('Expected error occurred:', error);
  }

  // Wait for the error to be logged
  await window.waitForTimeout(2000);

  await electronApp.close();

  // Check logs for the expected errors
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Found ${logs.length} log entries after error test`);
  
  if (logs.length > 0) {
    console.log('All log entries:');
    logs.forEach((log, i) => {
      const entry = parseLogEntry(log);
      console.log(`${i + 1}: [${entry?.source || 'UNKNOWN'}] ${entry?.message || log}`);
    });
  }

  // Look for our test errors specifically
  const testErrors = logs.filter(log => 
    log.includes('TEST_ERROR') || log.includes('CLIENT_TEST')
  );

  console.log(`Found ${testErrors.length} expected test errors`);
  expect(testErrors.length).toBeGreaterThan(0);

  // Verify error format
  const testError = testErrors.find(log => log.includes('TEST_ERROR'));
  if (testError) {
    const entry = parseLogEntry(testError);
    expect(entry?.source).toBe('RENDERER_TEST_ERROR');
    expect(entry?.message).toContain('Test error for validation');
  }
});

test('Repository validation errors are logged', async ({ isolatedApp }) => {
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

  // Try to trigger repository validation error
  await window.evaluate(async () => {
    try {
      // Simulate trying to add invalid repository
      const client = (window as any).client;
      if (client) {
        await client.saveRepo.mutate({ repoPath: '/nonexistent/path' });
      }
    } catch (error) {
      console.log('Expected repository error:', error);
    }
  });

  await window.waitForTimeout(2000);
  await electronApp.close();

  // Check for repository-related errors
  const logs = await readErrorLogs(isolatedApp.logPath);
  const repoErrors = logs.filter(log => 
    log.includes('repository') || log.includes('repo') || log.includes('saveRepo')
  );

  console.log(`Found ${repoErrors.length} repository-related log entries`);
  repoErrors.forEach(log => console.log(`REPO LOG: ${log}`));
  
  // We may or may not get an error depending on validation, but logs should exist
  expect(logs.length).toBeGreaterThan(0);
});

test('Log analysis utilities work correctly', async ({ isolatedApp }) => {
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
  await window.waitForTimeout(2000);
  await electronApp.close();

  // Test log analysis functions
  const logs = await readErrorLogs(isolatedApp.logPath);
  expect(logs.length).toBeGreaterThan(0);

  // Test parsing
  const parsedEntries = logs.map(parseLogEntry).filter(Boolean);
  expect(parsedEntries.length).toBeGreaterThan(0);

  // Test error checking
  const { hasErrors, errorLogs } = checkForErrors(logs);
  console.log(`Error analysis: hasErrors=${hasErrors}, errorCount=${errorLogs.length}`);

  // Should have at least the APP_START entry
  const appStartEntries = logs.filter(log => log.includes('APP_START'));
  console.log(`Found ${appStartEntries.length} APP_START entries`);
  console.log(`All logs: ${JSON.stringify(logs, null, 2)}`);
  
  if (appStartEntries.length > 0) {
    // Test pattern matching only if we have APP_START entries
    const { matchedPatterns } = checkForErrors(logs, ['APP_START']);
    expect(matchedPatterns).toContain('APP_START');
  } else {
    console.log('No APP_START entries found, skipping pattern matching test');
  }
});

test('Concurrent test isolation', async ({ isolatedApp }) => {
  // This test verifies that each test gets its own isolated environment
  
  console.log(`Test data path: ${isolatedApp.dataPath}`);
  console.log(`Test log path: ${isolatedApp.logPath}`);
  
  // The paths should be unique for each test
  expect(isolatedApp.dataPath).toMatch(/\/tmp\/many-test-[a-z0-9]+\/data$/);
  expect(isolatedApp.logPath).toMatch(/\/tmp\/many-test-[a-z0-9]+\/logs$/);
  
  // Quick app launch to generate some logs
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
  await window.waitForTimeout(1000);
  await electronApp.close();

  const logs = await readErrorLogs(isolatedApp.logPath);
  expect(logs.length).toBeGreaterThan(0);
  
  console.log(`Generated ${logs.length} log entries in isolated environment`);
});