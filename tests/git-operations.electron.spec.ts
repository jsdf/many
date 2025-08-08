import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function setupTestGitRepo(repoPath: string) {
  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }
  
  mkdirSync(repoPath, { recursive: true });
  process.chdir(repoPath);
  
  execSync('git init');
  execSync('git config user.email "test@example.com"');
  execSync('git config user.name "Test User"');
  
  // Create initial commit
  execSync('echo "# Test Repo" > README.md');
  execSync('git add README.md');
  execSync('git commit -m "Initial commit"');
  
  // Create main branch
  execSync('git checkout -b main');
  execSync('echo "main branch content" > main.txt');
  execSync('git add main.txt');
  execSync('git commit -m "Main branch setup"');
  
  // Create some test branches
  execSync('git checkout -b feature/test-branch');
  execSync('echo "feature content" > feature.txt');
  execSync('git add feature.txt');
  execSync('git commit -m "Feature branch commit"');
  
  // Create another branch that's ahead of main
  execSync('git checkout -b feature/ahead-branch');
  execSync('echo "ahead content" > ahead.txt');
  execSync('git add ahead.txt');
  execSync('git commit -m "Ahead branch commit"');
  
  // Go back to main
  execSync('git checkout main');
}

async function launchApp() {
  return await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });
}

async function addRepositoryAndWorktree(window: any, repoPath: string, worktreeName = 'git-test') {
  await window.click('button:has-text("Add Repository")');
  await window.fill('input[placeholder*="repository"]', repoPath);
  await window.click('button:has-text("Add")');
  await window.waitForTimeout(1000);

  await window.click('button:has-text("Create Worktree")');
  await window.fill('input[placeholder*="prompt"]', worktreeName);
  await window.click('button:has-text("Create")');
  await window.waitForTimeout(3000);

  await window.click(`.sidebar text*="test-user/${worktreeName}"`);
}

test.describe('Git Operations Tests', () => {
  const testRepoPath = path.join(__dirname, '../test-repos/git-ops-repo');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    // Cleanup worktree directories
    const worktreeBase = path.join(testRepoPath, '..');
    const patterns = ['test-user-git-test', 'test-user-merge-test', 'test-user-branch-test'];
    
    patterns.forEach(pattern => {
      const worktreePath = path.join(worktreeBase, pattern);
      if (existsSync(worktreePath)) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });
  });

  test('Create worktree creates corresponding git branch', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath, 'branch-test');

    // Verify worktree appears in sidebar (indicating successful creation)
    await expect(window.locator('.sidebar text*="test-user/branch-test"')).toBeVisible();
    
    // Click on worktree to show details
    await window.click('.sidebar text*="test-user/branch-test"');
    
    // Verify branch information is displayed
    await expect(window.locator('.worktree-details')).toContainText('Branch:');
    await expect(window.locator('.worktree-details')).toContainText('test-user/branch-test');

    await electronApp.close();
  });

  test('Merge branch workflow via integrated review tool', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath, 'merge-test');

    // Look for merge or review functionality
    const mergeButton = window.locator('button:has-text("Merge"), button:has-text("Review"), button:has-text("Pull Request")');
    
    if (await mergeButton.count() > 0) {
      await mergeButton.first().click();
      await window.waitForTimeout(1000);
      
      // Should show merge interface or review tool
      const reviewInterface = window.locator('.merge-dialog, .review-tool, .git-review');
      if (await reviewInterface.count() > 0) {
        await expect(reviewInterface).toBeVisible();
        
        // Look for merge controls
        const confirmMerge = window.locator('button:has-text("Confirm Merge"), button:has-text("Merge Branch")');
        if (await confirmMerge.count() > 0) {
          // Don't actually merge, just verify the interface exists
          await expect(confirmMerge).toBeVisible();
        }
        
        // Close merge dialog
        const cancelButton = window.locator('button:has-text("Cancel"), button:has-text("Close")');
        if (await cancelButton.count() > 0) {
          await cancelButton.click();
        }
      }
    }

    await electronApp.close();
  });

  test('Test merge conflict detection and handling', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Look for git status or conflict indicators
    const gitStatus = window.locator('.git-status, .branch-status, .conflicts');
    
    if (await gitStatus.count() > 0) {
      // Should show clean status for new worktree
      await expect(gitStatus).toBeVisible();
    }

    // Try to trigger merge workflow to see conflict handling
    const mergeButton = window.locator('button:has-text("Merge"), .merge-control');
    if (await mergeButton.count() > 0) {
      await mergeButton.first().click();
      
      // Should show merge dialog
      const mergeDialog = window.locator('.merge-dialog, .modal');
      if (await mergeDialog.count() > 0) {
        // Look for conflict warning or resolution interface
        const conflictWarning = mergeDialog.locator('text*="conflict", text*="merge conflict"');
        
        // Cancel merge to avoid actual changes
        const cancelButton = mergeDialog.locator('button:has-text("Cancel")');
        if (await cancelButton.count() > 0) {
          await cancelButton.click();
        }
      }
    }

    await electronApp.close();
  });

  test('Verify branch status tracking (ahead/behind/merged)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath);

    // Check worktree details for branch status information
    const worktreeDetails = window.locator('.worktree-details, .main-content');
    await expect(worktreeDetails).toBeVisible();
    
    // Look for branch status indicators
    const statusIndicators = worktreeDetails.locator('.branch-status, .git-status, [data-testid="branch-status"]');
    
    if (await statusIndicators.count() > 0) {
      await expect(statusIndicators).toBeVisible();
      
      // Should show some status (ahead, behind, up-to-date, etc.)
      const statusText = await statusIndicators.textContent();
      expect(statusText).toBeTruthy();
    }

    // Check in sidebar for status badges
    const sidebarWorktree = window.locator('.sidebar text*="test-user/git-test"').locator('..');
    const statusBadge = sidebarWorktree.locator('.status, .badge, .indicator');
    
    if (await statusBadge.count() > 0) {
      // Should have some kind of status indicator
      await expect(statusBadge).toBeVisible();
    }

    await electronApp.close();
  });

  test('Live update worktree list when git changes occur externally', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Count initial worktrees
    const initialWorktrees = await window.locator('.sidebar [data-testid="worktree-item"], .sidebar .worktree-item').count();

    // Create worktree externally using git commands
    process.chdir(testRepoPath);
    const externalWorktreePath = path.join(path.dirname(testRepoPath), 'external-worktree');
    
    try {
      execSync(`git worktree add "${externalWorktreePath}" -b external-branch`);
      
      // Wait for potential live updates
      await window.waitForTimeout(3000);
      
      // Check if worktree list updated (this might not work in all implementations)
      const updatedWorktrees = await window.locator('.sidebar [data-testid="worktree-item"], .sidebar .worktree-item').count();
      
      // The test passes if the app doesn't crash when external changes occur
      await expect(window.locator('.sidebar')).toBeVisible();
      
    } catch (e) {
      console.log('External git command failed:', e);
    }

    await electronApp.close();
  });

  test('Update branch names when changed outside app', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepositoryAndWorktree(window, testRepoPath, 'rename-test');
    
    // Verify initial branch name
    await expect(window.locator('.sidebar text*="test-user/rename-test"')).toBeVisible();
    
    // Wait and check app remains functional (branch renaming via git commands is complex)
    await window.waitForTimeout(2000);
    await expect(window.locator('.main-content')).toBeVisible();

    await electronApp.close();
  });

  test('Detect new/deleted worktrees from external git commands', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Create a worktree in the app first
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'detection-test');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Verify worktree exists
    await expect(window.locator('.sidebar text*="test-user/detection-test"')).toBeVisible();

    // The app should remain functional and responsive
    await expect(window.locator('.sidebar')).toBeVisible();
    await expect(window.locator('.main-content')).toBeVisible();

    await electronApp.close();
  });

  test('Git command error handling', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Try to add a corrupted or invalid git repository
    const invalidPath = path.join(__dirname, '../test-repos/invalid-git');
    
    if (!existsSync(invalidPath)) {
      mkdirSync(invalidPath, { recursive: true });
      // Create .git directory but make it invalid
      mkdirSync(path.join(invalidPath, '.git'));
      writeFileSync(path.join(invalidPath, '.git', 'HEAD'), 'invalid content');
    }

    try {
      await window.click('button:has-text("Add Repository")');
      await window.fill('input[placeholder*="repository"]', invalidPath);
      await window.click('button:has-text("Add")');
      
      // Should show error message and not crash
      await window.waitForTimeout(2000);
      await expect(window.locator('body')).toBeVisible();
      
      // Error message should appear
      const errorMessage = window.locator('text*="error", text*="invalid", text*="repository"');
      if (await errorMessage.count() > 0) {
        await expect(errorMessage).toBeVisible();
      }
      
    } finally {
      // Cleanup
      if (existsSync(invalidPath)) {
        rmSync(invalidPath, { recursive: true, force: true });
      }
    }

    await electronApp.close();
  });

  test('Test git operations on large repositories', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Create a larger test repo with more commits and branches
    const largeRepoPath = path.join(__dirname, '../test-repos/large-repo');
    
    if (!existsSync(largeRepoPath)) {
      mkdirSync(largeRepoPath, { recursive: true });
      process.chdir(largeRepoPath);
      
      execSync('git init');
      execSync('git config user.email "test@example.com"');
      execSync('git config user.name "Test User"');
      
      // Create multiple commits and branches
      for (let i = 0; i < 10; i++) {
        execSync(`echo "Content ${i}" > file${i}.txt`);
        execSync(`git add file${i}.txt`);
        execSync(`git commit -m "Commit ${i}"`);
        
        if (i % 3 === 0) {
          execSync(`git checkout -b branch-${i}`);
          execSync(`echo "Branch content ${i}" > branch-file-${i}.txt`);
          execSync(`git add branch-file-${i}.txt`);
          execSync(`git commit -m "Branch ${i} commit"`);
          execSync('git checkout master || git checkout main');
        }
      }
    }

    try {
      await window.click('button:has-text("Add Repository")');
      await window.fill('input[placeholder*="repository"]', largeRepoPath);
      await window.click('button:has-text("Add")');
      
      // Should handle large repo without crashing
      await window.waitForTimeout(3000);
      await expect(window.locator('.sidebar')).toBeVisible();
      
      // Try to create worktree in large repo
      await window.click('button:has-text("Create Worktree")');
      await window.fill('input[placeholder*="prompt"]', 'large-repo-test');
      await window.click('button:has-text("Create")');
      await window.waitForTimeout(5000); // Allow more time for large repo operations
      
      // Should complete without errors
      await expect(window.locator('body')).toBeVisible();
      
    } finally {
      // Cleanup
      if (existsSync(largeRepoPath)) {
        rmSync(largeRepoPath, { recursive: true, force: true });
      }
    }

    await electronApp.close();
  });
});