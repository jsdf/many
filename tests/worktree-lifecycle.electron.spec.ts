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
  
  // Create main branch and some sample branches
  execSync('git checkout -b main');
  execSync('echo "main branch content" > main.txt');
  execSync('git add main.txt');
  execSync('git commit -m "Main branch commit"');
  
  execSync('git checkout -b feature/existing-branch');
  execSync('echo "existing feature" > feature.txt');
  execSync('git add feature.txt');
  execSync('git commit -m "Existing feature commit"');
  
  execSync('git checkout main');
}

async function launchApp() {
  return await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });
}

async function addRepository(window: any, repoPath: string) {
  await window.click('button:has-text("Add Repository")');
  await window.fill('input[placeholder*="repository"]', repoPath);
  await window.click('button:has-text("Add")');
  await window.waitForTimeout(1000); // Wait for repo to be added
}

test.describe('Worktree Lifecycle Tests', () => {
  const testRepoPath = path.join(testDir, 'worktree-test-repo');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    // Also cleanup any worktree directories that might have been created
    const worktreeBase = path.join(testRepoPath, '..');
    const worktreePaths = [
      path.join(worktreeBase, 'test-user-new-feature'),
      path.join(worktreeBase, 'test-user-ai-generated-branch'),
    ];
    
    worktreePaths.forEach(p => {
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
    });
  });

  test('Create worktree with custom branch name', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Click "Create Worktree" button
    await window.click('button:has-text("Create Worktree")');

    // Fill in worktree creation form
    await expect(window.locator('.modal:has-text("Create Worktree")')).toBeVisible();
    await window.fill('input[placeholder*="prompt"]', 'new feature');
    
    // Submit the form
    await window.click('button:has-text("Create")');

    // Wait for worktree to be created and appear in the list
    await window.waitForTimeout(3000);
    
    // Verify worktree appears in sidebar
    await expect(window.locator('.sidebar').locator('text*="test-user/new-feature"')).toBeVisible();

    await electronApp.close();
  });

  test('Create worktree from existing branch', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    await window.click('button:has-text("Create Worktree")');
    
    // Select "From existing branch" option
    await window.click('input[type="radio"][value="existing"], label:has-text("From existing branch")');
    
    // Select an existing branch from dropdown
    await window.click('.branch-selector, select[name="branch"]');
    await window.click('option:has-text("feature/existing-branch")');
    
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Verify worktree appears in sidebar
    await expect(window.locator('.sidebar').locator('text*="feature/existing-branch"')).toBeVisible();

    await electronApp.close();
  });

  test('Verify AI-generated branch naming (username/sanitized-prompt)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    await window.click('button:has-text("Create Worktree")');
    
    // Use a prompt with special characters that should be sanitized
    await window.fill('input[placeholder*="prompt"]', 'AI Generated Feature!!! @#$');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Verify the branch name is sanitized (should be test-user/ai-generated-feature)
    await expect(window.locator('.sidebar').locator('text*="test-user/ai-generated-feature"')).toBeVisible();

    await electronApp.close();
  });

  test('Test branch name sanitization (special chars, length limits)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    await window.click('button:has-text("Create Worktree")');
    
    // Use a very long prompt with special characters
    const longPrompt = 'This is a very long prompt with special characters!@#$%^&*()[]{}|\\:";\'<>?,./~`';
    await window.fill('input[placeholder*="prompt"]', longPrompt);
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Branch name should be sanitized and shortened (max 50 chars)
    const sanitizedBranch = window.locator('.sidebar').locator('[data-testid="worktree-item"]').first();
    const branchText = await sanitizedBranch.textContent();
    
    // Should contain only valid characters and be reasonably short
    expect(branchText).toMatch(/test-user\/[a-z0-9-]+/);
    expect(branchText!.length).toBeLessThan(70); // username + slash + 50 chars + some buffer

    await electronApp.close();
  });

  test('Verify worktree appears in sidebar immediately after creation', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    const initialWorktreeCount = await window.locator('.sidebar [data-testid="worktree-item"]').count();

    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'quick test');
    await window.click('button:has-text("Create")');

    // Wait and verify new worktree appears
    await window.waitForTimeout(3000);
    const newWorktreeCount = await window.locator('.sidebar [data-testid="worktree-item"]').count();
    
    expect(newWorktreeCount).toBeGreaterThan(initialWorktreeCount);
    await expect(window.locator('.sidebar').locator('text*="test-user/quick-test"')).toBeVisible();

    await electronApp.close();
  });

  test('Click worktree in sidebar shows details in main pane', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Create a worktree first
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'test details view');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Click on the worktree in sidebar
    await window.click('.sidebar text*="test-user/test-details-view"');
    
    // Verify main content shows worktree details
    await expect(window.locator('.main-content')).toContainText('test-user/test-details-view');
    await expect(window.locator('.worktree-details')).toBeVisible();

    await electronApp.close();
  });

  test('Verify worktree metadata display (branch, path, status)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'metadata test');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Click on worktree to show details
    await window.click('.sidebar text*="test-user/metadata-test"');

    // Verify metadata is displayed
    await expect(window.locator('.worktree-details')).toContainText('Branch:');
    await expect(window.locator('.worktree-details')).toContainText('Path:');
    await expect(window.locator('.worktree-details')).toContainText('test-user/metadata-test');

    await electronApp.close();
  });

  test('Archive merged worktree (should succeed without prompt)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Create and merge a worktree
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'merged feature');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Select the worktree and click archive
    await window.click('.sidebar text*="test-user/merged-feature"');
    await window.click('button:has-text("Archive")');

    // Should not show confirmation dialog for merged branches
    // Just verify the worktree is removed from the list
    await window.waitForTimeout(2000);
    await expect(window.locator('.sidebar text*="test-user/merged-feature"')).not.toBeVisible();

    await electronApp.close();
  });

  test('Archive unmerged worktree (should show confirmation dialog)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'unmerged feature');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Select the worktree and click archive
    await window.click('.sidebar text*="test-user/unmerged-feature"');
    await window.click('button:has-text("Archive")');

    // Should show confirmation dialog
    await expect(window.locator('.modal:has-text("Archive Worktree")')).toBeVisible();
    await expect(window.locator('text*="not fully merged"')).toBeVisible();
    
    // Cancel the operation
    await window.click('button:has-text("Cancel")');
    
    // Worktree should still be visible
    await expect(window.locator('.sidebar text*="test-user/unmerged-feature"')).toBeVisible();

    await electronApp.close();
  });
});