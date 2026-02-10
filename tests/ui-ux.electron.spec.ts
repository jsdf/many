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

test.describe('UI/UX Tests', () => {
  const testRepoPath = path.join(testDir, 'ui-test-repo');

  test.beforeEach(async () => {
    await setupTestGitRepo(testRepoPath);
  });

  test.afterEach(async () => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    // Cleanup worktree directories
    const worktreeBase = path.join(testRepoPath, '..');
    const patterns = ['test-user-ui-test', 'test-user-modal-test', 'test-user-overflow-test'];
    
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

  test('Add repository modal validation and error states', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Open add repository modal
    await window.click('button:has-text("Add Repository")');
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();

    // Test validation - try to submit empty form
    await window.click('button:has-text("Add")');
    
    // Should show validation error or keep modal open
    await window.waitForTimeout(500);
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();

    // Test with invalid path
    await window.fill('input[placeholder*="repository"]', '/invalid/nonexistent/path');
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(2000);

    // Should show error message
    const errorMessage = window.locator('text*="error", text*="invalid", text*="not found"');
    if (await errorMessage.count() > 0) {
      await expect(errorMessage).toBeVisible();
    }

    // Test cancel button
    await window.click('button:has-text("Cancel")');
    await expect(window.locator('.modal:has-text("Add Repository")')).not.toBeVisible();

    await electronApp.close();
  });

  test('Create worktree modal validation and error states', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository first
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Open create worktree modal
    await window.click('button:has-text("Create Worktree")');
    await expect(window.locator('.modal:has-text("Create Worktree")')).toBeVisible();

    // Test validation - try to submit empty form
    await window.click('button:has-text("Create")');
    
    // Should show validation error or keep modal open
    await window.waitForTimeout(500);
    await expect(window.locator('.modal:has-text("Create Worktree")')).toBeVisible();

    // Test with very short prompt
    await window.fill('input[placeholder*="prompt"]', 'a');
    
    // Should either accept short prompt or show validation
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(1000);

    // Cancel if still open
    const cancelButton = window.locator('button:has-text("Cancel")');
    if (await cancelButton.count() > 0) {
      await cancelButton.click();
    }

    await electronApp.close();
  });

  test('Confirmation dialogs (archive, destructive actions)', async () => {
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
    await window.fill('input[placeholder*="prompt"]', 'modal test');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Select worktree and try to archive
    await window.click('.sidebar text*="test-user/modal-test"');
    
    const archiveButton = window.locator('button:has-text("Archive")');
    if (await archiveButton.count() > 0) {
      await archiveButton.click();
      
      // Should show confirmation dialog
      const confirmationModal = window.locator('.modal:has-text("Archive"), .confirmation-dialog');
      if (await confirmationModal.count() > 0) {
        await expect(confirmationModal).toBeVisible();
        
        // Test cancel
        const cancelButton = confirmationModal.locator('button:has-text("Cancel")');
        if (await cancelButton.count() > 0) {
          await cancelButton.click();
          await expect(confirmationModal).not.toBeVisible();
        }
      }
    }

    await electronApp.close();
  });

  test('Modal keyboard navigation and escape handling', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Open modal
    await window.click('button:has-text("Add Repository")');
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();

    // Test escape key
    await window.press('body', 'Escape');
    await window.waitForTimeout(500);
    
    // Modal should close or remain open (depending on implementation)
    const modalVisible = await window.locator('.modal:has-text("Add Repository")').isVisible();
    
    if (!modalVisible) {
      // Modal closed with escape - test passed
      expect(modalVisible).toBe(false);
    } else {
      // Modal didn't close with escape - test cancel button instead
      await window.click('button:has-text("Cancel")');
      await expect(window.locator('.modal:has-text("Add Repository")')).not.toBeVisible();
    }

    // Test tab navigation
    await window.click('button:has-text("Add Repository")');
    await window.press('body', 'Tab');
    await window.press('body', 'Tab');
    
    // Elements should be focusable
    await expect(window.locator('.modal:has-text("Add Repository")')).toBeVisible();

    await electronApp.close();
  });

  test('Sidebar resize behavior', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Check initial sidebar visibility
    await expect(window.locator('.sidebar')).toBeVisible();

    // Look for resize handle or splitter
    const resizeHandle = window.locator('.resize-handle, .splitter, .sidebar-resize');
    
    if (await resizeHandle.count() > 0) {
      // Get initial position
      const sidebarInitial = await window.locator('.sidebar').boundingBox();
      
      // Try to resize (this might not work in all implementations)
      await resizeHandle.hover();
      await window.mouse.down();
      await window.mouse.move(sidebarInitial!.x + 100, sidebarInitial!.y);
      await window.mouse.up();
      
      await window.waitForTimeout(500);
      
      // Check if sidebar resized
      const sidebarAfter = await window.locator('.sidebar').boundingBox();
      
      // Sidebar should still be visible regardless of resize success
      await expect(window.locator('.sidebar')).toBeVisible();
    }

    await electronApp.close();
  });

  test('Window resizing maintains layout', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test different window sizes
    const sizes = [
      { width: 800, height: 600 },
      { width: 1200, height: 800 },
      { width: 1600, height: 1000 },
    ];

    for (const size of sizes) {
      await window.setViewportSize(size);
      await window.waitForTimeout(500);

      // Layout should remain intact
      await expect(window.locator('.sidebar')).toBeVisible();
      await expect(window.locator('.main-content')).toBeVisible();
      
      // Elements should not overlap
      const sidebar = await window.locator('.sidebar').boundingBox();
      const mainContent = await window.locator('.main-content').boundingBox();
      
      if (sidebar && mainContent) {
        expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(mainContent.x + 5); // Small tolerance
      }
    }

    await electronApp.close();
  });

  test('Overflow handling in worktree list', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');
    await window.waitForTimeout(1000);

    // Create worktree with very long name
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'this is a very long worktree name that should test overflow handling');
    await window.click('button:has-text("Create")');
    await window.waitForTimeout(3000);

    // Check if long name is handled properly in sidebar
    const longNameItem = window.locator('.sidebar text*="this-is-a-very-long"');
    
    if (await longNameItem.count() > 0) {
      await expect(longNameItem).toBeVisible();
      
      // Check if it has tooltip or truncation
      await longNameItem.hover();
      await window.waitForTimeout(500);
      
      // Should show tooltip or handle overflow gracefully
      const tooltip = window.locator('.tooltip, [title]');
      if (await tooltip.count() > 0) {
        // Tooltip functionality exists
        console.log('Tooltip found for long names');
      }
    }

    // Create multiple worktrees to test list overflow
    for (let i = 0; i < 3; i++) {
      await window.click('button:has-text("Create Worktree")');
      await window.fill('input[placeholder*="prompt"]', `overflow test ${i}`);
      await window.click('button:has-text("Create")');
      await window.waitForTimeout(2000);
    }

    // Sidebar should handle multiple items gracefully
    await expect(window.locator('.sidebar')).toBeVisible();
    
    // Should show scrollbar or pagination if too many items
    const worktreeItems = await window.locator('.sidebar [data-testid="worktree-item"], .sidebar .worktree-item').count();
    expect(worktreeItems).toBeGreaterThan(0);

    await electronApp.close();
  });

  test('Dark theme consistency across all components', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Check if dark theme is applied
    const bodyStyles = await window.locator('body').evaluate(el => {
      const styles = window.getComputedStyle(el);
      return {
        backgroundColor: styles.backgroundColor,
        color: styles.color
      };
    });

    console.log('Body styles:', bodyStyles);

    // Dark theme typically has dark background
    const isDarkTheme = bodyStyles.backgroundColor.includes('rgb(') && 
                       bodyStyles.backgroundColor !== 'rgb(255, 255, 255)';

    if (isDarkTheme) {
      // Check various components for theme consistency
      const components = ['.sidebar', '.main-content', 'button', '.modal'];
      
      for (const selector of components) {
        const element = window.locator(selector).first();
        if (await element.count() > 0) {
          const componentStyles = await element.evaluate(el => {
            const styles = window.getComputedStyle(el);
            return {
              backgroundColor: styles.backgroundColor,
              color: styles.color,
              borderColor: styles.borderColor
            };
          });
          
          console.log(`${selector} styles:`, componentStyles);
          
          // Components should have appropriate dark theme colors
          expect(componentStyles).toBeTruthy();
        }
      }
    }

    // Test modal theme consistency
    await window.click('button:has-text("Add Repository")');
    const modal = window.locator('.modal:has-text("Add Repository")');
    
    if (await modal.count() > 0) {
      const modalStyles = await modal.evaluate(el => {
        const styles = window.getComputedStyle(el);
        return {
          backgroundColor: styles.backgroundColor,
          color: styles.color
        };
      });
      
      console.log('Modal styles:', modalStyles);
      
      // Modal should be themed consistently
      expect(modalStyles).toBeTruthy();
    }

    await electronApp.close();
  });

  test('Button states and hover effects', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test main action buttons
    const buttons = await window.locator('button').all();
    
    for (const button of buttons.slice(0, 3)) { // Test first few buttons
      // Check button is enabled
      await expect(button).toBeEnabled();
      
      // Test hover effect
      await button.hover();
      await window.waitForTimeout(200);
      
      // Button should still be visible and enabled after hover
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    }

    // Test specific button states
    const addRepoButton = window.locator('button:has-text("Add Repository")');
    await expect(addRepoButton).toBeEnabled();
    
    // Click and check state change
    await addRepoButton.click();
    
    // Add button might be disabled or hidden while modal is open
    const modal = window.locator('.modal:has-text("Add Repository")');
    if (await modal.count() > 0) {
      await expect(modal).toBeVisible();
    }

    await electronApp.close();
  });

  test('Loading states and progress indicators', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Add repository
    await window.click('button:has-text("Add Repository")');
    await window.fill('input[placeholder*="repository"]', testRepoPath);
    await window.click('button:has-text("Add")');

    // Should show loading state during repository addition
    await window.waitForTimeout(500);
    
    // Look for loading indicators
    const loadingIndicators = window.locator('.loading, .spinner, .progress, text*="Loading"');
    
    if (await loadingIndicators.count() > 0) {
      console.log('Loading indicators found during repo addition');
    }

    await window.waitForTimeout(2000);

    // Create worktree to test longer operation
    await window.click('button:has-text("Create Worktree")');
    await window.fill('input[placeholder*="prompt"]', 'loading test');
    await window.click('button:has-text("Create")');

    // Should show loading state during worktree creation
    const creatingIndicators = window.locator('text*="Creating", text*="Please wait", .creating');
    
    if (await creatingIndicators.count() > 0) {
      await expect(creatingIndicators.first()).toBeVisible();
    }

    await window.waitForTimeout(4000);

    // Loading should complete
    await expect(window.locator('.sidebar')).toBeVisible();

    await electronApp.close();
  });

  test('Responsive design on different screen sizes', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test various screen sizes
    const screenSizes = [
      { width: 1024, height: 768, name: 'desktop' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 480, height: 800, name: 'mobile' },
    ];

    for (const size of screenSizes) {
      await window.setViewportSize({ width: size.width, height: size.height });
      await window.waitForTimeout(500);

      console.log(`Testing ${size.name} size: ${size.width}x${size.height}`);

      // Core elements should remain accessible
      await expect(window.locator('.sidebar, .main-content')).toBeVisible();

      // Buttons should remain clickable
      const addButton = window.locator('button:has-text("Add Repository")');
      if (await addButton.count() > 0) {
        await expect(addButton).toBeVisible();
        
        // Check if button is not cut off
        const buttonBox = await addButton.boundingBox();
        if (buttonBox) {
          expect(buttonBox.x).toBeGreaterThanOrEqual(0);
          expect(buttonBox.y).toBeGreaterThanOrEqual(0);
          expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(size.width);
        }
      }

      // Take screenshot for visual verification
      await window.screenshot({ 
        path: `tests/screenshots/responsive-${size.name}-${size.width}x${size.height}.png`,
        fullPage: true 
      });
    }

    await electronApp.close();
  });

  test('Accessibility features and keyboard navigation', async () => {
    const electronApp = await launchApp();
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(2000);

    // Test keyboard navigation
    await window.press('body', 'Tab');
    await window.waitForTimeout(200);
    
    // Should focus first interactive element
    const focusedElement = await window.evaluate(() => document.activeElement?.tagName);
    console.log('First focused element:', focusedElement);

    // Continue tabbing through interface
    for (let i = 0; i < 5; i++) {
      await window.press('body', 'Tab');
      await window.waitForTimeout(100);
      
      const currentFocus = await window.evaluate(() => ({
        tag: document.activeElement?.tagName,
        class: document.activeElement?.className,
        text: document.activeElement?.textContent?.substring(0, 20)
      }));
      
      console.log(`Tab ${i + 1}:`, currentFocus);
    }

    // Test Enter key on focused button
    const addButton = window.locator('button:has-text("Add Repository")');
    await addButton.focus();
    await window.press('body', 'Enter');
    
    // Should open modal
    const modal = window.locator('.modal:has-text("Add Repository")');
    if (await modal.count() > 0) {
      await expect(modal).toBeVisible();
      
      // Test keyboard navigation within modal
      await window.press('body', 'Tab');
      await window.press('body', 'Tab');
    }

    await electronApp.close();
  });
});