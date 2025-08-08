import { Page } from '@playwright/test';

/**
 * UI Action helpers for interacting with the Many Worktree Manager through the UI
 * These functions simulate real user interactions instead of calling internal APIs
 */

export class UIActions {
  constructor(private page: Page) {}

  // Repository Management Actions
  async addRepository(repoPath: string) {
    // Click the "Add Repo" button in the sidebar
    await this.page.click('[data-testid="add-repo-button"]');
    
    // Wait for modal to appear
    await this.page.waitForSelector('[data-testid="repo-path-input"]');
    
    // Fill in the repository path
    await this.page.fill('[data-testid="repo-path-input"]', repoPath);
    
    // Submit the form
    await this.page.click('[data-testid="add-repo-submit"]');
    
    // Wait for modal to disappear
    await this.page.waitForSelector('[data-testid="repo-path-input"]', { state: 'detached' });
  }

  async selectRepository(repoName: string) {
    // Use the repository selector dropdown
    await this.page.selectOption('[data-testid="repo-selector"]', { label: repoName });
    
    // Wait for worktrees to load
    await this.page.waitForTimeout(1000);
  }

  async openRepositoryPicker() {
    await this.page.click('[data-testid="add-repo-button"]');
    await this.page.waitForSelector('[data-testid="browse-folder-button"]');
    
    // Note: We can't actually interact with the native folder picker in tests
    // This would trigger the native OS dialog which Playwright can't control
    await this.page.click('[data-testid="add-repo-cancel"]');
  }

  // Worktree Management Actions
  async createWorktree(branchName: string) {
    // Click the "Create Worktree" button
    await this.page.click('[data-testid="create-worktree-button"]');
    
    // Wait for modal to appear
    await this.page.waitForSelector('[data-testid="branch-name-input"]');
    
    // Fill in the branch name
    await this.page.fill('[data-testid="branch-name-input"]', branchName);
    
    // Submit the form
    await this.page.click('[data-testid="create-worktree-submit"]');
    
    // Wait for modal to disappear (creation might take time)
    await this.page.waitForSelector('[data-testid="branch-name-input"]', { 
      state: 'detached',
      timeout: 10000 
    });
  }

  async selectWorktree(branchName: string) {
    // Click on the worktree item in the sidebar
    await this.page.click(`[data-testid="worktree-item-${branchName}"]`);
    
    // Wait for worktree to be selected
    await this.page.waitForTimeout(500);
  }

  // Test and Debug Actions
  async triggerTRPCTest() {
    // Click the tRPC test button (for testing purposes)
    await this.page.click('[data-testid="trpc-test-button"]');
    
    // Wait for result to appear
    await this.page.waitForSelector('[data-testid="trpc-result"]', { timeout: 5000 });
    
    // Get the result text
    const resultText = await this.page.textContent('[data-testid="trpc-result"]');
    return resultText;
  }

  // Wait for Application State
  async waitForApplicationReady() {
    // Wait for the main UI elements to be present
    await this.page.waitForSelector('[data-testid="add-repo-button"]');
    await this.page.waitForSelector('[data-testid="repo-selector"]');
    
    // Wait a moment for any initialization to complete
    await this.page.waitForTimeout(1000);
  }

  async waitForRepositoryLoaded(repoName: string) {
    // Wait for the repository to appear in the selector
    await this.page.waitForFunction(
      (name) => {
        const selector = document.querySelector('[data-testid="repo-selector"]') as HTMLSelectElement;
        if (!selector) return false;
        
        for (const option of selector.options) {
          if (option.textContent?.includes(name)) {
            return true;
          }
        }
        return false;
      },
      repoName,
      { timeout: 5000 }
    );
  }

  async waitForWorktreesLoaded() {
    // Wait for either worktree items to appear or empty state message
    await this.page.waitForFunction(() => {
      return document.querySelector('[data-testid^="worktree-item-"]') !== null ||
             document.querySelector('.empty-state') !== null;
    }, { timeout: 5000 });
  }

  // Verification Helpers
  async getRepositoryList(): Promise<string[]> {
    const selector = await this.page.locator('[data-testid="repo-selector"]');
    const options = await selector.locator('option').allTextContents();
    return options.filter(option => option !== 'Select a repository...');
  }

  async getWorktreeList(): Promise<string[]> {
    const worktreeItems = await this.page.locator('[data-testid^="worktree-item-"]').all();
    const branches: string[] = [];
    
    for (const item of worktreeItems) {
      const branchElement = await item.locator('.worktree-branch').textContent();
      if (branchElement) {
        branches.push(branchElement);
      }
    }
    
    return branches;
  }

  async getCurrentRepository(): Promise<string | null> {
    const value = await this.page.inputValue('[data-testid="repo-selector"]');
    return value || null;
  }

  async getSelectedWorktree(): Promise<string | null> {
    const activeItem = await this.page.locator('[data-testid^="worktree-item-"].active').first();
    
    if (await activeItem.count() === 0) {
      return null;
    }
    
    const branchText = await activeItem.locator('.worktree-branch').textContent();
    return branchText;
  }

  // Error Simulation (for testing error handling)
  async simulateError() {
    // This is a special case - we need to trigger errors through the UI
    // We can do this by trying to add an invalid repository path
    await this.addRepository('/nonexistent/invalid/path');
  }

  // Modal Interactions
  async isModalOpen(modalType: 'add-repo' | 'create-worktree'): Promise<boolean> {
    const selectors = {
      'add-repo': '[data-testid="repo-path-input"]',
      'create-worktree': '[data-testid="branch-name-input"]'
    };
    
    const element = await this.page.locator(selectors[modalType]).count();
    return element > 0;
  }

  async cancelModal(modalType: 'add-repo' | 'create-worktree') {
    const cancelSelectors = {
      'add-repo': '[data-testid="add-repo-cancel"]',
      'create-worktree': '[data-testid="create-worktree-cancel"]'
    };
    
    await this.page.click(cancelSelectors[modalType]);
  }
}

// Helper function to create UI actions for a page
export function createUIActions(page: Page): UIActions {
  return new UIActions(page);
}

// Common workflow helpers
export async function setupTestRepository(page: Page, repoPath: string): Promise<UIActions> {
  const ui = createUIActions(page);
  
  await ui.waitForApplicationReady();
  
  // Only add repository if it's not already there
  const repos = await ui.getRepositoryList();
  const repoName = repoPath.split('/').pop() || repoPath;
  
  if (!repos.some(repo => repo.includes(repoName))) {
    try {
      await ui.addRepository(repoPath);
      await ui.waitForRepositoryLoaded(repoName);
    } catch (error) {
      console.log(`Repository ${repoPath} may already exist or be invalid:`, error);
    }
  }
  
  await ui.selectRepository(repoName);
  await ui.waitForWorktreesLoaded();
  
  return ui;
}