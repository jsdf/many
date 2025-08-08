import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, readErrorLogs, checkForErrors, parseLogEntry } from './test-utils';
import { createUIActions } from './ui-actions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ❌ OLD WAY: Direct API calls
/*
test('Repository validation errors are logged (OLD WAY)', async ({ isolatedApp }) => {
  // ... setup code ...
  
  // PROBLEM: Direct API call bypasses UI
  await window.evaluate(async () => {
    const client = (window as any).client;
    if (client) {
      await client.saveRepo.mutate({ repoPath: '/nonexistent/path' });
    }
  });
  
  // ... verification ...
});
*/

// ✅ NEW WAY: UI interactions only
test('Repository validation errors through UI', async ({ isolatedApp }) => {
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

  const ui = createUIActions(window);
  await ui.waitForApplicationReady();

  // ✅ Trigger error through UI interaction like a real user would
  try {
    await ui.addRepository('/nonexistent/path/that/should/fail');
  } catch (error) {
    console.log('Expected repository validation error through UI:', error);
  }

  await electronApp.close();

  // Check for repository-related errors in logs
  const logs = await readErrorLogs(isolatedApp.logPath);
  const repoErrors = logs.filter(log => 
    log.includes('repository') || 
    log.includes('repo') || 
    log.includes('Failed to add repository')
  );

  console.log(`Found ${repoErrors.length} repository-related log entries`);
  repoErrors.forEach(log => console.log(`REPO ERROR: ${log}`));
  
  // We may or may not get specific error logs depending on validation
  // But the app should not crash
  const crashLogs = logs.filter(log => 
    log.includes('CRASH') || log.includes('UNCAUGHT_EXCEPTION')
  );
  expect(crashLogs.length).toBe(0);
});

// ❌ OLD WAY: Direct console/API manipulation
/*
test('Error handling with direct logging (OLD WAY)', async ({ isolatedApp }) => {
  // PROBLEM: Direct API manipulation
  await window.evaluate(async () => {
    if (window.electronAPI && window.electronAPI.logRendererError) {
      await window.electronAPI.logRendererError('Test error', 'TEST_ERROR');
    }
  });
});
*/

// ✅ NEW WAY: Trigger errors through natural UI interactions
test('Error handling through natural UI interactions', async ({ isolatedApp }) => {
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

  const ui = createUIActions(window);
  await ui.waitForApplicationReady();

  // ✅ Trigger errors through realistic user actions
  
  // 1. Try to create worktree without repository (should be prevented by UI)
  const createButton = window.locator('[data-testid=\"create-worktree-button\"]');
  await expect(createButton).toBeDisabled();
  
  // 2. Try invalid repository paths
  await ui.addRepository(''); // Empty path
  await ui.addRepository('/dev/null'); // Invalid path
  await ui.addRepository('not-a-path'); // Malformed path
  
  // 3. Test modal interactions that might cause errors
  await window.click('[data-testid=\"add-repo-button\"]');
  await window.fill('[data-testid=\"repo-path-input\"]', '/tmp/fake-repo');
  await window.click('[data-testid=\"add-repo-submit\"]');
  
  await electronApp.close();

  // Verify error handling worked correctly
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Natural interaction test generated ${logs.length} log entries`);
  
  if (logs.length > 0) {
    console.log('Log entries from natural interactions:');
    logs.forEach((log, i) => {
      const entry = parseLogEntry(log);
      console.log(`${i + 1}: [${entry?.source || 'UNKNOWN'}] ${entry?.message || log}`);
    });
  }

  // The app should handle errors gracefully - no crashes
  const { hasErrors, errorLogs } = checkForErrors(logs, ['CRASH', 'UNCAUGHT_EXCEPTION']);
  const crashErrors = errorLogs.filter(log => 
    log.includes('CRASH') || log.includes('UNCAUGHT_EXCEPTION')
  );
  
  expect(crashErrors.length).toBe(0);
});

// ✅ Test actual user workflow that might encounter errors
test('Complete user workflow error scenarios', async ({ isolatedApp }) => {
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

  const ui = createUIActions(window);
  await ui.waitForApplicationReady();

  // Scenario 1: User tries to add repository but cancels
  await window.click('[data-testid=\"add-repo-button\"]');
  await window.fill('[data-testid=\"repo-path-input\"]', '/some/path');
  await ui.cancelModal('add-repo');
  
  // Scenario 2: User submits empty form
  await window.click('[data-testid=\"add-repo-button\"]');
  // Don't fill anything
  const submitButton = window.locator('[data-testid=\"add-repo-submit\"]');
  await expect(submitButton).toBeDisabled(); // Should be disabled for empty input
  await ui.cancelModal('add-repo');
  
  // Scenario 3: User tries multiple invalid paths
  const invalidPaths = [
    '/root/restricted',
    '/proc/self',
    '//invalid//path',
    'relative/path',
    ''
  ];
  
  for (const invalidPath of invalidPaths) {
    try {
      await ui.addRepository(invalidPath);
      console.log(`Repository path ${invalidPath} was accepted (unexpected)`);
    } catch (error) {
      console.log(`Repository path ${invalidPath} was rejected (expected)`);
    }
  }
  
  await electronApp.close();

  // Analyze logs for error patterns
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Complete workflow test generated ${logs.length} log entries`);
  
  // Should not have any crashes despite invalid inputs
  const crashLogs = logs.filter(log => 
    log.includes('CRASH') || 
    log.includes('EXCEPTION') ||
    log.includes('FATAL')
  );
  
  expect(crashLogs.length).toBe(0);
  
  // May have validation errors, which is expected and good
  const validationLogs = logs.filter(log =>
    log.includes('validation') || 
    log.includes('invalid') ||
    log.includes('Failed to')
  );
  
  console.log(`Found ${validationLogs.length} expected validation errors`);
});