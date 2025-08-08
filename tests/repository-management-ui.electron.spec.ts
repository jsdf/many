import { expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { test, readErrorLogs, expectNoErrors } from './test-utils';
import { createUIActions, setupTestRepository } from './ui-actions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('Add repository through UI', async ({ isolatedApp }) => {
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
  
  // Wait for app to be ready
  await ui.waitForApplicationReady();
  
  // Verify initial state - no repositories
  const initialRepos = await ui.getRepositoryList();
  expect(initialRepos.length).toBe(0);
  
  // Add a repository through the UI
  const testRepoPath = '/tmp/test-repo-ui';
  
  // This will fail because the path doesn't exist, but it tests the UI workflow
  try {
    await ui.addRepository(testRepoPath);
  } catch (error) {
    console.log('Expected error adding non-existent repo:', error);
  }
  
  await electronApp.close();
  
  // Verify no unexpected errors in logs
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Repository addition test generated ${logs.length} log entries`);
  
  // We expect some logs from the failed repository addition, but no crashes
  const crashLogs = logs.filter(log => log.includes('CRASH') || log.includes('EXCEPTION'));
  expect(crashLogs.length).toBe(0);
});

test('Create worktree through UI', async ({ isolatedApp }) => {
  // Note: This test requires a real git repository to work properly
  // For this example, we'll simulate the UI interactions without a real repo
  
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
  
  // Test that Create Worktree button is disabled when no repo is selected
  const createButton = window.locator('[data-testid=\"create-worktree-button\"]');
  await expect(createButton).toBeDisabled();
  
  // Try to click the button anyway - should not open modal
  await createButton.click({ force: true });
  
  // Verify modal didn't open
  const modalOpen = await ui.isModalOpen('create-worktree');
  expect(modalOpen).toBe(false);
  
  await electronApp.close();
  await expectNoErrors(isolatedApp.logPath);
});

test('tRPC functionality through UI', async ({ isolatedApp }) => {
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
  
  // Test tRPC functionality through the UI test button
  const result = await ui.triggerTRPCTest();
  expect(result).toContain('Success: Hello tRPC!');
  
  await electronApp.close();
  
  // Verify tRPC operations didn't generate errors
  const logs = await readErrorLogs(isolatedApp.logPath);
  const tRPCErrors = logs.filter(log => 
    log.includes('tRPC') && 
    (log.includes('error') || log.includes('failed'))
  );
  
  expect(tRPCErrors.length).toBe(0);
});

test('UI state persistence', async ({ isolatedApp }) => {
  // First session - add a repository
  const electronApp1 = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  const window1 = await electronApp1.firstWindow();
  await window1.waitForLoadState('domcontentloaded');
  
  const ui1 = createUIActions(window1);
  await ui1.waitForApplicationReady();
  
  // Try to add a repository (will fail but should be persisted in isolated data)
  try {
    await ui1.addRepository('/tmp/test-persistence');
  } catch (error) {
    console.log('Expected error:', error);
  }
  
  await electronApp1.close();
  
  // Second session - check if state persisted
  const electronApp2 = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });

  const window2 = await electronApp2.firstWindow();
  await window2.waitForLoadState('domcontentloaded');
  
  const ui2 = createUIActions(window2);
  await ui2.waitForApplicationReady();
  
  // In a real scenario with valid repos, we would check if they persisted
  // For now, just verify the app starts correctly with the same data
  const repos = await ui2.getRepositoryList();
  console.log('Persisted repositories:', repos);
  
  await electronApp2.close();
  
  // Verify no errors across both sessions
  await expectNoErrors(isolatedApp.logPath);
});

test('Modal interactions through UI', async ({ isolatedApp }) => {
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
  
  // Test Add Repository modal
  await window.click('[data-testid=\"add-repo-button\"]');
  let modalOpen = await ui.isModalOpen('add-repo');
  expect(modalOpen).toBe(true);
  
  // Cancel the modal
  await ui.cancelModal('add-repo');
  modalOpen = await ui.isModalOpen('add-repo');
  expect(modalOpen).toBe(false);
  
  // Test that create worktree modal doesn't open without repo selection
  await window.click('[data-testid=\"create-worktree-button\"]', { force: true });
  modalOpen = await ui.isModalOpen('create-worktree');
  expect(modalOpen).toBe(false);
  
  await electronApp.close();
  await expectNoErrors(isolatedApp.logPath);
});

test('Error handling through UI interactions', async ({ isolatedApp }) => {
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
  
  // Try to trigger an error through invalid repository path
  await ui.simulateError();
  
  await electronApp.close();
  
  // Check for error logs - we should have some from the invalid repository
  const logs = await readErrorLogs(isolatedApp.logPath);
  console.log(`Error simulation generated ${logs.length} log entries`);
  
  // Should not have any crash errors, but may have validation errors
  const crashLogs = logs.filter(log => 
    log.includes('CRASH') || 
    log.includes('UNCAUGHT_EXCEPTION') ||
    log.includes('RENDERER_CRASH')
  );
  expect(crashLogs.length).toBe(0);
});

// Test with a real git repository (skipped by default)
test.skip('Full workflow with real repository', async ({ isolatedApp }) => {
  // This test would require setting up a real git repository
  // It's skipped by default but shows the pattern for full E2E testing
  
  const realRepoPath = process.env.TEST_REPO_PATH;
  if (!realRepoPath) {
    console.log('Skipping real repository test - set TEST_REPO_PATH environment variable');
    return;
  }
  
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
  
  const ui = await setupTestRepository(window, realRepoPath);
  
  // Full workflow: add repo -> select it -> create worktree
  await ui.createWorktree('test-branch-ui');
  
  // Verify worktree was created
  const worktrees = await ui.getWorktreeList();
  expect(worktrees).toContain('test-branch-ui');
  
  await electronApp.close();
  await expectNoErrors(isolatedApp.logPath);
});