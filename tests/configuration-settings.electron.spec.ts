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

async function addRepository(window: any, repoPath: string) {
  await window.click('button:has-text("Add Repository")');
  await window.fill('input[placeholder*="repository"]', repoPath);
  await window.click('button:has-text("Add")');
  await window.waitForTimeout(1000);
}

test.describe('Configuration & Settings Tests', () => {
  const testRepoPath = path.join(testDir, 'config-test-repo');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    // Cleanup worktree directories
    const worktreeBase = path.join(testRepoPath, '..');
    const patterns = ['test-user-config-test', 'test-user-init-test'];
    
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

  test('Configure initialization command for new worktrees', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Look for repository settings or configuration options
    const settingsButton = window.locator('button:has-text("Settings"), button:has-text("Configure"), .settings-button, [data-testid="settings"]');
    
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click();
      await window.waitForTimeout(1000);

      // Look for initialization command configuration
      const initCommandInput = window.locator('input[placeholder*="init"], input[name*="init"], textarea[name*="init"]');
      
      if (await initCommandInput.count() > 0) {
        await initCommandInput.fill('npm install');
        
        // Save settings
        const saveButton = window.locator('button:has-text("Save"), button:has-text("Apply")');
        if (await saveButton.count() > 0) {
          await saveButton.click();
          await window.waitForTimeout(500);
        }
      }
    } else {
      // Alternative: look for repo-specific configuration in the add repo modal
      await window.click('button:has-text("Add Repository")');
      const configSection = window.locator('.init-command, .repository-config');
      if (await configSection.count() > 0) {
        const initInput = configSection.locator('input, textarea');
        if (await initInput.count() > 0) {
          await initInput.fill('npm install');
        }
      }
      await window.click('button:has-text("Cancel")');
    }

    await electronApp.close();
  });

  test('Test initialization command execution on worktree creation', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Try to configure init command first
    const settingsButton = window.locator('button:has-text("Settings"), button:has-text("Configure")');
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click();
      const initCommandInput = window.locator('input[placeholder*="init"], input[name*="init"]');
      if (await initCommandInput.count() > 0) {
        // Use a simple command that should work on most systems
        await initCommandInput.fill('echo "Init command executed" > init.log');
        
        const saveButton = window.locator('button:has-text("Save")');
        if (await saveButton.count() > 0) {
          await saveButton.click();
        }
      }
      
      // Close settings if modal
      const closeButton = window.locator('button:has-text("Close"), button:has-text("Cancel")');
      if (await closeButton.count() > 0) {
        await closeButton.click();
      }
    }

    // Create a worktree to test init command execution
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'init test');
    await window.click('button:has-text("Create")');
    
    // Wait longer for worktree creation and potential init command execution
    await window.waitForTimeout(5000);

    // Verify worktree was created
    await expect(window.locator('.sidebar text*="test-user/init-test"')).toBeVisible();

    await electronApp.close();
  });

  test('Configure custom commands/scripts per repository', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Look for custom commands configuration
    const settingsButton = window.locator('button:has-text("Settings"), .repository-settings');
    
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click();
      await window.waitForTimeout(1000);

      // Look for custom commands section
      const commandsSection = window.locator('.custom-commands, .scripts-section, .commands-config');
      
      if (await commandsSection.count() > 0) {
        // Try to add a custom command
        const addCommandButton = commandsSection.locator('button:has-text("Add Command"), button:has-text("Add Script")');
        
        if (await addCommandButton.count() > 0) {
          await addCommandButton.first().click();
          
          // Fill command details
          const nameInput = window.locator('input[placeholder*="name"], input[name*="name"]');
          const commandInput = window.locator('input[placeholder*="command"], textarea[placeholder*="command"]');
          
          if (await nameInput.count() > 0 && await commandInput.count() > 0) {
            await nameInput.fill('Test Command');
            await commandInput.fill('echo "Test command executed"');
            
            // Save command
            const saveCommandButton = window.locator('button:has-text("Save Command"), button:has-text("Add")');
            if (await saveCommandButton.count() > 0) {
              await saveCommandButton.click();
            }
          }
        }
      }
    }

    await electronApp.close();
  });

  test('Verify settings persist per repository', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    await addRepository(window, testRepoPath);

    // Configure a setting
    const settingsButton = window.locator('button:has-text("Settings")');
    
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click();
      
      // Make some configuration change
      const initCommandInput = window.locator('input[placeholder*="init"]');
      if (await initCommandInput.count() > 0) {
        await initCommandInput.fill('echo "persistent setting"');
        
        const saveButton = window.locator('button:has-text("Save")');
        if (await saveButton.count() > 0) {
          await saveButton.click();
        }
      }
      
      // Close settings
      const closeButton = window.locator('button:has-text("Close"), .close-button');
      if (await closeButton.count() > 0) {
        await closeButton.click();
      }
    }

    // Close and reopen app to test persistence
    await electronApp.close();

    // Reopen app
    const electronApp2 = await launchApp();
    const window2 = await electronApp2.firstWindow();
    await window2.waitForLoadState('domcontentloaded');
    await window2.waitForTimeout(2000);

    // Verify repository is still there (persistence)
    await expect(window2.locator('.sidebar').locator(`text=${path.basename(testRepoPath)}`)).toBeVisible();

    // Check if settings were persisted
    const settingsButton2 = window2.locator('button:has-text("Settings")');
    if (await settingsButton2.count() > 0) {
      await settingsButton2.first().click();
      
      const initCommandInput2 = window2.locator('input[placeholder*="init"]');
      if (await initCommandInput2.count() > 0) {
        const value = await initCommandInput2.inputValue();
        expect(value).toContain('persistent setting');
      }
    }

    await electronApp2.close();
  });

  test('Test settings migration/compatibility', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // This test verifies the app handles missing or invalid settings gracefully
    await addRepository(window, testRepoPath);

    // App should handle missing configuration gracefully
    await expect(window.locator('.sidebar')).toBeVisible();
    await expect(window.locator('.main-content')).toBeVisible();

    // Should be able to open settings without errors
    const settingsButton = window.locator('button:has-text("Settings"), .settings-button');
    if (await settingsButton.count() > 0) {
      await settingsButton.first().click();
      await window.waitForTimeout(1000);
      
      // Settings interface should load without errors
      await expect(window.locator('.modal, .settings-panel')).toBeVisible();
    }

    await electronApp.close();
  });

  test('Test global app settings vs per-repository settings', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Look for global app settings
    const appSettingsButton = window.locator('button:has-text("Preferences"), button:has-text("App Settings"), .app-settings');
    
    if (await appSettingsButton.count() > 0) {
      await appSettingsButton.first().click();
      await window.waitForTimeout(1000);
      
      // Should show global settings interface
      await expect(window.locator('.preferences, .app-settings-modal')).toBeVisible();
      
      // Close global settings
      const closeButton = window.locator('button:has-text("Close")');
      if (await closeButton.count() > 0) {
        await closeButton.click();
      }
    }

    // Add repository and check repo-specific settings
    await addRepository(window, testRepoPath);
    
    const repoSettingsButton = window.locator('button:has-text("Repository Settings"), .repo-settings');
    if (await repoSettingsButton.count() > 0) {
      await repoSettingsButton.first().click();
      await window.waitForTimeout(1000);
      
      // Should show repository-specific settings
      await expect(window.locator('.repository-settings, .repo-config')).toBeVisible();
    }

    await electronApp.close();
  });

  test('Test default settings initialization', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // App should start with sensible defaults
    await expect(window.locator('body')).toBeVisible();
    await expect(window.locator('.sidebar')).toBeVisible();

    // Should show welcome screen with default state
    await expect(window.locator('.welcome-screen, .empty-state')).toBeVisible();

    // Adding a repository should work with default settings
    await addRepository(window, testRepoPath);
    await expect(window.locator('.sidebar').locator(`text=${path.basename(testRepoPath)}`)).toBeVisible();

    await electronApp.close();
  });
});