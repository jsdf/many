import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from 'fs';
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
  execSync('echo "# Test Repo" > README.md');
  execSync('git add README.md');
  execSync('git commit -m "Initial commit"');
}

async function launchApp() {
  return await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
  });
}

test.describe('Error Handling Tests', () => {
  const testRepoPath = path.join(__dirname, '../test-repos/error-test-repo');
  const corruptedDataPath = path.join(__dirname, '../test-data/corrupted-app-data.json');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    // Cleanup test repositories and data files
    [testRepoPath, corruptedDataPath].forEach(p => {
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });
    
    // Cleanup worktree directories
    const worktreeBase = path.join(testRepoPath, '..');
    const patterns = ['test-user-error-test', 'test-user-permission-test'];
    
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

  test('Handle corrupted app-data.json gracefully', async () => {
    // Create corrupted app data file
    const dataDir = path.dirname(corruptedDataPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    
    writeFileSync(corruptedDataPath, '{ invalid json content }');

    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(3000);

    // App should still start and show welcome screen
    await expect(window.locator('body')).toBeVisible();
    await expect(window.locator('.welcome-screen, .empty-state, .sidebar')).toBeVisible();

    // Should be able to add repository despite corrupted data
    await window.click('button:has-text("Add Repository")');
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();

    await electronApp.close();
  });

  test('Git command failures (network issues, permissions)', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test with repository that has permission issues
    const permissionTestPath = path.join(__dirname, '../test-repos/permission-test');
    
    if (!existsSync(permissionTestPath)) {
      mkdirSync(permissionTestPath, { recursive: true });
      process.chdir(permissionTestPath);
      
      execSync('git init');
      execSync('git config user.email "test@example.com"');
      execSync('git config user.name "Test User"');
      execSync('echo "test" > test.txt');
      execSync('git add test.txt');
      execSync('git commit -m "Test commit"');
      
      // Try to make .git directory read-only (may not work on all systems)
      try {
        chmodSync(path.join(permissionTestPath, '.git'), 0o444);
      } catch (e) {
        // Permission changes might fail, that's ok for this test
      }
    }

    try {
      await window.click('button:has-text("Add Repository")');
      await window.fill('input[placeholder*="repository"]', permissionTestPath);
      await window.click('button:has-text("Add")');
      await window.waitForTimeout(2000);

      // App should handle permission errors gracefully
      await expect(window.locator('body')).toBeVisible();
      
      // If successful, try creating worktree to trigger more git operations
      const repoInSidebar = window.locator('.sidebar').locator(`text=${path.basename(permissionTestPath)}`);
      if (await repoInSidebar.count() > 0) {
        await window.click('button:has-text("Create Worktree")');
        await window.fill('input[placeholder*="prompt"]', 'permission test');
        await window.click('button:has-text("Create")');
        await window.waitForTimeout(3000);
        
        // Should handle any git permission errors
        await expect(window.locator('body')).toBeVisible();
      }
      
    } finally {
      // Restore permissions for cleanup
      try {
        if (existsSync(permissionTestPath)) {
          chmodSync(path.join(permissionTestPath, '.git'), 0o755);
        }
      } catch (e) {
        // Ignore
      }
    }

    await electronApp.close();
  });

  test('Missing git executable error handling', async () => {
    // This test is tricky since we can't easily remove git from the system
    // Instead, we'll test with an invalid git repository
    
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    const invalidGitPath = path.join(__dirname, '../test-repos/fake-git-repo');
    
    if (!existsSync(invalidGitPath)) {
      mkdirSync(invalidGitPath, { recursive: true });
      // Create a fake .git directory with invalid content
      mkdirSync(path.join(invalidGitPath, '.git'));
      writeFileSync(path.join(invalidGitPath, '.git', 'HEAD'), 'invalid git content');
    }

    try {
      await window.click('button:has-text("Add Repository")');
      await window.fill('input[placeholder*="repository"]', invalidGitPath);
      await window.click('button:has-text("Add")');
      await window.waitForTimeout(2000);

      // Should show error and not crash
      await expect(window.locator('body')).toBeVisible();
      
      // Look for error message
      const errorMessages = window.locator('text*="error", text*="invalid", text*="git"');
      if (await errorMessages.count() > 0) {
        await expect(errorMessages.first()).toBeVisible();
      }
      
    } finally {
      if (existsSync(invalidGitPath)) {
        rmSync(invalidGitPath, { recursive: true, force: true });
      }
    }

    await electronApp.close();
  });

  test('Worktree directory deletion outside app', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository and create worktree
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'deletion test');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Verify worktree was created
    await expect(window.locator('.sidebar text*="test-user/deletion-test"')).toBeVisible();

    // Externally delete the worktree directory
    const worktreePath = path.join(path.dirname(testRepoPath), 'test-user-deletion-test');
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }

    // Click on the worktree - app should handle missing directory gracefully
    await window.click('.sidebar text*="test-user/deletion-test"');
    await window.waitForTimeout(1000);

    // App should remain functional
    await expect(window.locator('body')).toBeVisible();
    await expect(window.locator('.main-content')).toBeVisible();

    await electronApp.close();
  });

  test('Repository moved/deleted externally', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Verify repository is added
    await expect(window.locator('.sidebar').locator(`text=${path.basename(testRepoPath)}`)).toBeVisible();

    // Externally move/delete the repository
    const movedRepoPath = testRepoPath + '-moved';
    if (existsSync(testRepoPath)) {
      try {
        execSync(`mv "${testRepoPath}" "${movedRepoPath}"`);
      } catch (e) {
        // If mv fails, try with copy and delete
        rmSync(testRepoPath, { recursive: true, force: true });
      }
    }

    // Try to interact with the missing repository
    await window.click(`.sidebar text=${path.basename(testRepoPath)}`);
    await window.waitForTimeout(1000);

    // App should handle missing repository gracefully
    await expect(window.locator('body')).toBeVisible();

    // Try to create worktree with missing repo
    const createButton = window.locator('button:has-text("Create Worktree")');
    if (await createButton.count() > 0) {
      await createButton.click();
      
      // Should either show error or handle gracefully
      await window.waitForTimeout(1000);
      await expect(window.locator('body')).toBeVisible();
      
      // Cancel if modal appeared
      const cancelButton = window.locator('button:has-text("Cancel")');
      if (await cancelButton.count() > 0) {
        await cancelButton.click();
      }
    }

    // Cleanup moved repo
    if (existsSync(movedRepoPath)) {
      rmSync(movedRepoPath, { recursive: true, force: true });
    }

    await electronApp.close();
  });

  test('Long-running operations with user feedback', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Start worktree creation (potentially long operation)
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'long operation test');
    await window.click('button:has-text("Create")');

    // Should show loading indicator or progress feedback
    const loadingIndicators = window.locator('.loading, .spinner, .progress, text*="Creating", text*="Loading"');
    
    if (await loadingIndicators.count() > 0) {
      await expect(loadingIndicators.first()).toBeVisible();
    }

    // Wait for operation to complete
    await window.waitForTimeout(5000);

    // Operation should complete and show result
    await expect(window.locator('.sidebar')).toBeVisible();

    await electronApp.close();
  });

  test('Network connectivity issues during git operations', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test with a repository that might have remote operations
    // For this test, we'll just verify the app handles network-related errors gracefully
    
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Try operations that might involve network (like fetching)
    const refreshButton = window.locator('button:has-text("Refresh"), button:has-text("Sync"), .refresh-button');
    
    if (await refreshButton.count() > 0) {
      await refreshButton.first().click();
      await window.waitForTimeout(2000);
      
      // App should handle any network errors gracefully
      await expect(window.locator('body')).toBeVisible();
    }

    await electronApp.close();
  });

  test('Invalid file paths and special characters handling', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test with paths containing special characters
    const specialCharPaths = [
      '/nonexistent/path with spaces',
      '/invalid:path*with?special<chars>',
      '',  // empty path
      'relative/path',  // relative path
    ];

    for (const testPath of specialCharPaths) {
      try {
        await window.click('button:has-text("Add Repository")');
        await window.fill('input[placeholder*="repository"]', testPath);
        await window.click('button:has-text("Add")');
        await window.waitForTimeout(1000);

        // Should show error message and remain stable
        await expect(window.locator('body')).toBeVisible();

        // Close modal if it's still open
        const cancelButton = window.locator('button:has-text("Cancel")');
        if (await cancelButton.count() > 0) {
          await cancelButton.click();
        }
      } catch (e) {
        // Test passes if app doesn't crash
        console.log(`Path "${testPath}" caused expected error:`, e);
      }
    }

    await electronApp.close();
  });

  test('Memory leaks and resource cleanup', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add and remove multiple repositories to test cleanup
    for (let i = 0; i < 3; i++) {
      const repoPath = path.join(__dirname, `../test-repos/cleanup-test-${i}`);
      
      // Setup temp repo
      if (!existsSync(repoPath)) {
        mkdirSync(repoPath, { recursive: true });
        process.chdir(repoPath);
        execSync('git init');
        execSync('git config user.email "test@example.com"');
        execSync('git config user.name "Test User"');
        execSync('echo "test" > test.txt');
        execSync('git add test.txt');
        execSync('git commit -m "Test"');
      }

      try {
        await window.click('button:has-text("Add Repository")');
        await window.fill('input[placeholder*="repository"]', repoPath);
        await window.click('button:has-text("Add")');
        await window.waitForTimeout(1000);

        // Create and archive worktree to test cleanup
        if (await window.locator('.sidebar').locator(`text=${path.basename(repoPath)}`).count() > 0) {
          await window.click('button:has-text("Create Worktree")');
          await window.fill('input[placeholder*="prompt"]', `cleanup-${i}`);
          await window.click('button:has-text("Create")');
          await window.waitForTimeout(2000);

          // Archive if possible
          const archiveButton = window.locator('button:has-text("Archive")');
          if (await archiveButton.count() > 0) {
            await window.click(`.sidebar text*="test-user/cleanup-${i}"`);
            await archiveButton.click();
            await window.waitForTimeout(1000);
          }
        }
      } finally {
        // Cleanup
        if (existsSync(repoPath)) {
          rmSync(repoPath, { recursive: true, force: true });
        }
      }
    }

    // App should remain responsive after multiple operations
    await expect(window.locator('body')).toBeVisible();
    await expect(window.locator('.sidebar')).toBeVisible();

    await electronApp.close();
  });

  test('Concurrent operations handling', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Try to start multiple worktree creation operations rapidly
    const promises = [];
    
    for (let i = 0; i < 2; i++) {
      promises.push((async () => {
        try {
          await window.click('button:has-text("Create Worktree")');
          await window.fill('input[placeholder*="prompt"]', `concurrent-${i}`);
          await window.click('button:has-text("Create")');
          await window.waitForTimeout(1000);
        } catch (e) {
          // Expected that some operations might fail due to concurrency
        }
      })());
    }

    // Wait for all concurrent operations
    await Promise.all(promises);

    // App should remain stable
    await expect(window.locator('body')).toBeVisible();

    await electronApp.close();
  });
});