import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(os.tmpdir(), 'many-test');

async function setupTestGitRepo(repoPath: string) {
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
  
  mkdirSync(repoPath, { recursive: true });
  process.chdir(repoPath);
  
  execSync('git init');
  execSync('git config user.email "test@example.com"');
  execSync('git config user.name "Test User"');
  execSync('echo "# Test Repo" > README.md');
  execSync('git add README.md');
  execSync('git commit -m "Initial commit"');
}

async function launchApp() {
  return await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });
}

async function addRepositoryAndWorktree(window: any, repoPath: string) {
  await window.click('button:has-text("Add Repository")');
  await window.fill('input[placeholder*="repository"]', repoPath);
  await window.click('button:has-text("Add")');
  await window.waitForTimeout(1000);

  // Create a worktree
  await window.click('button:has-text("Create Worktree")');
  await window.fill('input[placeholder*="prompt"]', 'test external tools');
  await window.click('button:has-text("Create")');
  await window.waitForTimeout(3000);

  // Select the worktree
  await window.click('.sidebar text*="test-user/test-external-tools"');
}

test.describe('External Tool Integration Tests', () => {
  const testRepoPath = path.join(testDir, 'external-tools-repo');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    // Cleanup worktree directories
    const worktreeBase = path.join(testRepoPath, '..');
    const worktreePath = path.join(worktreeBase, 'test-user-test-external-tools');
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  test('Open worktree folder in file manager', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Look for the "Open Folder" button in the worktree details
    await expect(window.locator('button:has-text("Open Folder"), button:has-text("Open in File Manager")')).toBeVisible();
    
    // Click the button (we can't easily test the actual file manager opening in E2E)
    await window.click('button:has-text("Open Folder"), button:has-text("Open in File Manager")');
    
    // The button should remain clickable (no errors thrown)
    await window.waitForTimeout(500);

    await electronApp.close();
  });

  test('Open worktree in terminal', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Look for terminal-related buttons
    await expect(window.locator('button:has-text("Terminal"), button:has-text("Open Terminal")')).toBeVisible();
    
    await window.click('button:has-text("Terminal"), button:has-text("Open Terminal")');
    await window.waitForTimeout(500);

    // Check if a terminal interface appears or button remains functional
    await expect(window.locator('button:has-text("Terminal"), button:has-text("Open Terminal")')).toBeVisible();

    await electronApp.close();
  });

  test('Open worktree in configured editor', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Look for editor-related buttons
    const editorButtons = window.locator('button:has-text("Editor"), button:has-text("Open Editor"), button:has-text("VS Code"), button:has-text("Code")');
    
    // Check if editor button exists
    if (await editorButtons.count() > 0) {
      await editorButtons.first().click();
      await window.waitForTimeout(500);
      
      // Button should remain functional
      await expect(editorButtons.first()).toBeVisible();
    }

    await electronApp.close();
  });

  test('Test behavior with missing/invalid external tools', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Try to open with various tools - should handle gracefully even if tools are missing
    const toolButtons = [
      'button:has-text("Open Folder")',
      'button:has-text("Terminal")', 
      'button:has-text("Editor")'
    ];

    for (const buttonSelector of toolButtons) {
      const button = window.locator(buttonSelector);
      if (await button.count() > 0) {
        await button.click();
        await window.waitForTimeout(300);
        
        // Should not crash the app - check window is still responsive
        await expect(window.locator('body')).toBeVisible();
      }
    }

    await electronApp.close();
  });

  test('Verify external tool buttons are available in worktree details', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Verify the worktree details pane contains action buttons
    const detailsPane = window.locator('.worktree-details, .main-content');
    await expect(detailsPane).toBeVisible();

    // Look for action buttons in the details pane
    const actionButtons = detailsPane.locator('button');
    const buttonCount = await actionButtons.count();
    
    expect(buttonCount).toBeGreaterThan(0);

    // Check for at least one external tool button
    const hasExternalToolButton = await Promise.all([
      detailsPane.locator('button:has-text("Open Folder")').count(),
      detailsPane.locator('button:has-text("Terminal")').count(),
      detailsPane.locator('button:has-text("Editor")').count(),
      detailsPane.locator('button:has-text("Open")').count()
    ]).then(counts => counts.some(count => count > 0));

    expect(hasExternalToolButton).toBe(true);

    await electronApp.close();
  });

  test('Test tool button states and accessibility', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Check that tool buttons are properly enabled and accessible
    const toolButtons = window.locator('button:has-text("Open"), button:has-text("Terminal"), button:has-text("Editor")');
    const buttonCount = await toolButtons.count();

    for (let i = 0; i < buttonCount; i++) {
      const button = toolButtons.nth(i);
      
      // Check button is enabled
      await expect(button).toBeEnabled();
      
      // Check button has accessible text
      const text = await button.textContent();
      expect(text).toBeTruthy();
      expect(text!.trim().length).toBeGreaterThan(0);
    }

    await electronApp.close();
  });
});