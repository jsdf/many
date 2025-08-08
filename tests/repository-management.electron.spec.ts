import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test setup helper functions
async function setupTestGitRepo(repoPath: string) {
  // Clean up if exists
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
  
  // Create test git repository
  mkdirSync(repoPath, { recursive: true });
  process.chdir(repoPath);
  
  execSync('git init');
  execSync('git config user.email "test@example.com"');
  execSync('git config user.name "Test User"');
  
  // Create initial commit
  execSync('echo "# Test Repo" > README.md');
  execSync('git add README.md');
  execSync('git commit -m "Initial commit"');
}

async function launchApp() {
  return await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });
}

test.describe('Core Repository Management Tests', () => {
  const testRepoPath = path.join(__dirname, '../test-repos/test-repo-1');
  const testRepoPath2 = path.join(__dirname, '../test-repos/test-repo-2');

  test.beforeEach(async () => {
    // Setup test repositories
    await setupTestGitRepo(testRepoPath);
    await setupTestGitRepo(testRepoPath2);
  });

  test.afterEach(async () => {
    // Cleanup test repositories
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    if (existsSync(testRepoPath2)) {
      rmSync(testRepoPath2, { recursive: true, force: true });
    }
  });

  test('Add repository via folder picker dialog', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // Wait for app to load
    await window.waitForTimeout(2000);

    // Click "Add Repository" button
    await window.click('button:has-text("Add Repository")');

    // Since we can't easily mock the folder picker in E2E tests,
    // we'll verify the modal opens instead
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();
    
    // Check that the modal has the expected form elements
    await expect(window.locator('input[placeholder*="repository"]')).toBeVisible();
    await expect(window.locator('button:has-text("Browse")')).toBeVisible();
    await expect(window.locator('button:has-text("Add")')).toBeVisible();
    await expect(window.locator('button:has-text("Cancel")')).toBeVisible();

    await electronApp.close();
  });

  test('Verify repository appears in sidebar after adding', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Since we can't easily mock folder picker, we'll simulate adding via the path input
    await window.click('button:has-text("Add Repository")');
    
    // Fill in the path manually (this would normally be set by folder picker)
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');

    // Verify repository appears in the sidebar
    await expect(window.locator('.sidebar').locator(`text=${path.basename(testRepoPath)}`)).toBeVisible();

    await electronApp.close();
  });

  test('Test invalid/non-git directories are rejected', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Create a non-git directory
    const nonGitPath = path.join(__dirname, '../test-repos/non-git-dir');
    if (!existsSync(nonGitPath)) {
      mkdirSync(nonGitPath, { recursive: true });
    }

    try {
      await window.click('button:has-text("Add Repository")');
      await window.fill('input[placeholder*="repository"]', nonGitPath);
      await window.click('button:has-text("Add")');

      // Should show error message
      await expect(window.locator('text*="not a valid git repository"')).toBeVisible({ timeout: 5000 });

    } finally {
      // Cleanup
      if (existsSync(nonGitPath)) {
        rmSync(nonGitPath, { recursive: true, force: true });
      }
    }

    await electronApp.close();
  });

  test('Test duplicate repository prevention', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository first time
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');

    // Try to add the same repository again
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');

    // Should show error about duplicate
    await expect(window.locator('text*="already added"')).toBeVisible({ timeout: 5000 });

    await electronApp.close();
  });

  test('Select different repositories from dropdown', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add first repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');

    // Add second repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath2);
    await window.click('button:has-text("Add")');

    // Verify both repositories are in the dropdown/sidebar
    const repoSelector = window.locator('.repository-selector, .sidebar .repository-list');
    await expect(repoSelector.locator(`text=${path.basename(testRepoPath)}`)).toBeVisible();
    await expect(repoSelector.locator(`text=${path.basename(testRepoPath2)}`)).toBeVisible();

    // Select different repository
    await window.click(`text=${path.basename(testRepoPath2)}`);
    
    // Verify the selection changed (main content should update)
    await expect(window.locator('.main-content')).toContainText(path.basename(testRepoPath2));

    await electronApp.close();
  });

  test('Test empty state when no repositories exist', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Should show welcome/empty state
    await expect(window.locator('.welcome-screen, .empty-state')).toBeVisible();
    await expect(window.locator('text*="Add your first repository"')).toBeVisible();

    await electronApp.close();
  });
});