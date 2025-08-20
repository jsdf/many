# UI-Only Testing Guide

This document explains the approach to testing the Many Worktree Manager application through UI interactions only, without direct RPC/API calls.

## Why UI-Only Testing?

### Problems with Direct API Testing

❌ **Direct API calls bypass the UI layer**:
```typescript
// BAD: Bypasses UI validation, user experience, and real workflows
await window.evaluate(async () => {
  const client = (window as any).client;
  await client.saveRepo.mutate({ repoPath: '/test/path' });
});
```

❌ **Tests don't represent real user behavior**  
❌ **Can miss UI validation bugs**  
❌ **Don't test the complete user journey**  
❌ **May pass even when UI is broken**  

### Benefits of UI-Only Testing

✅ **Tests simulate real user interactions**:
```typescript
// GOOD: Simulates how users actually interact with the app
const ui = createUIActions(window);
await ui.addRepository('/test/path'); // Clicks buttons, fills forms, etc.
```

✅ **Catches UI/UX issues**  
✅ **Tests complete user workflows**  
✅ **Validates form validation and error handling**  
✅ **Ensures accessibility and usability**  

## Implementation

### 1. Test Selectors Added

All interactive UI elements now have `data-testid` attributes:

```html
<!-- Repository management -->
<button data-testid="add-repo-button">Add Repo</button>
<select data-testid="repo-selector">...</select>
<input data-testid="repo-path-input" />

<!-- Worktree management -->
<button data-testid="create-worktree-button">Create Worktree</button>
<div data-testid="worktree-item-main">...</div>
<input data-testid="branch-name-input" />

<!-- Test utilities removed - tRPC tested through normal operations -->
```

### 2. UI Action Helpers

The `UIActions` class provides high-level methods for common user workflows:

```typescript
import { createUIActions } from './ui-actions';

const ui = createUIActions(window);

// Repository management
await ui.addRepository('/path/to/repo');
await ui.selectRepository('my-repo');

// Worktree management  
await ui.createWorktree('feature-branch');
await ui.selectWorktree('main');

// State verification
const repos = await ui.getRepositoryList();
const worktrees = await ui.getWorktreeList();
```

### 3. Test Examples

#### Basic UI Interaction Test
```typescript
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
  await ui.waitForApplicationReady();
  
  // Test through UI only
  await ui.addRepository('/tmp/test-repo');
  
  const repos = await ui.getRepositoryList();
  expect(repos).toContain('test-repo');
  
  await electronApp.close();
  await expectNoErrors(isolatedApp.logPath);
});
```

#### Error Handling Test
```typescript
test('Error handling through UI', async ({ isolatedApp }) => {
  const ui = createUIActions(window);
  
  // Test invalid inputs through UI
  await ui.addRepository('/nonexistent/path');
  
  // Verify error handling worked (no crashes)
  const logs = await readErrorLogs(isolatedApp.logPath);
  const crashes = logs.filter(log => log.includes('CRASH'));
  expect(crashes.length).toBe(0);
});
```

#### tRPC Testing Through Normal Operations
```typescript
test('tRPC functionality through normal operations', async ({ isolatedApp }) => {
  const ui = createUIActions(window);
  
  // tRPC is tested through normal app operations
  const repos = await ui.getRepositoryList(); // Uses tRPC getSavedRepos
  expect(Array.isArray(repos)).toBe(true);
  
  // Verify no tRPC errors in logs
  const logs = await readErrorLogs(isolatedApp.logPath);
  const tRPCErrors = logs.filter(log => 
    log.includes('tRPC') && log.includes('error')
  );
  expect(tRPCErrors.length).toBe(0);
});
```

## When Direct API Testing is Unavoidable

In some cases, direct API access may be necessary, but these should be rare:

### 1. Testing Internal APIs Not Exposed in UI
```typescript
// Only if there's no UI way to trigger this functionality
test('Internal logging system', async () => {
  await window.evaluate(() => {
    window.electronAPI.logRendererError('Test', 'INTERNAL_TEST');
  });
});
```

### 2. Setup/Teardown Operations
```typescript
// For test data setup where UI would be too slow
test('Complex data setup', async () => {
  // Setup test data directly
  await setupTestRepository();
  
  // Then test through UI
  const ui = createUIActions(window);
  await ui.selectRepository('test-repo');
  // ... UI testing
});
```

### 3. Testing Edge Cases Not Reachable Through UI
```typescript
// Only when UI doesn't allow testing the edge case
test('API error handling', async () => {
  // Simulate network failure or other edge case
  await window.evaluate(() => {
    // Trigger specific error condition
  });
});
```

## Best Practices

### 1. Always Start with UI-Only Approach
Try to test through UI first. Only use direct API calls if absolutely necessary.

### 2. Use Realistic Test Data
```typescript
// GOOD: Realistic repository paths
await ui.addRepository('/home/user/projects/my-repo');

// BAD: Artificial test data
await ui.addRepository('test-repo-123');
```

### 3. Test Complete User Journeys
```typescript
test('Complete worktree workflow', async () => {
  const ui = createUIActions(window);
  
  // Full user journey
  await ui.addRepository('/path/to/repo');
  await ui.selectRepository('my-repo');  
  await ui.createWorktree('feature-branch');
  await ui.selectWorktree('feature-branch');
  
  // Verify end state
  const selected = await ui.getSelectedWorktree();
  expect(selected).toBe('feature-branch');
});
```

### 4. Test Error Scenarios Naturally
```typescript
// Test errors that users would actually encounter
await ui.addRepository(''); // Empty input
await ui.addRepository('/nonexistent'); // Invalid path
await ui.createWorktree('invalid/branch/name'); // Invalid branch name
```

### 5. Always Verify No Crashes
```typescript
test('Error handling', async ({ isolatedApp }) => {
  // ... trigger error through UI ...
  
  await electronApp.close();
  
  // Verify app handled error gracefully
  const logs = await readErrorLogs(isolatedApp.logPath);
  const crashes = logs.filter(log => 
    log.includes('CRASH') || 
    log.includes('UNCAUGHT_EXCEPTION')
  );
  expect(crashes.length).toBe(0);
});
```

## Migration Guide

### From Direct API Tests to UI Tests

#### Before (Direct API):
```typescript
await window.evaluate(async () => {
  const client = (window as any).client;
  await client.saveRepo.mutate({ repoPath: '/test' });
});
```

#### After (UI-Only):
```typescript
const ui = createUIActions(window);
await ui.addRepository('/test');
```

### Identify Tests That Need Migration

1. Search for `window.evaluate`
2. Search for `client.` calls
3. Search for `electronAPI.` calls (except logging)
4. Search for direct RPC method names

### Refactoring Strategy

1. **Add test selectors** to UI components
2. **Create UI action methods** for common workflows  
3. **Replace direct API calls** with UI interactions
4. **Test complete user journeys** instead of isolated functions
5. **Verify through UI state** instead of internal state

## Files Added/Modified

- ✅ `tests/ui-actions.ts` - UI interaction helpers
- ✅ `tests/repository-management-ui.electron.spec.ts` - UI-only test examples
- ✅ `tests/error-handling-ui-refactored.electron.spec.ts` - Refactored error handling tests
- ✅ `src/renderer/src/components/Sidebar.tsx` - Added test selectors
- ✅ `src/renderer/src/components/AddRepoModal.tsx` - Added test selectors
- ✅ `src/renderer/src/components/CreateWorktreeModal.tsx` - Added test selectors
- ✅ `src/renderer/src/App.tsx` - Added test selectors

## Limitations

### 1. Native OS Dialogs
```typescript
// Cannot test native folder picker through Playwright
await ui.openRepositoryPicker(); // Only tests opening, not selection
```

### 2. File System Operations
Tests with real file system operations require actual git repositories and are slower.

### 3. Complex State Setup
For complex test scenarios, some direct API setup may be needed, but testing should still be done through UI.

The goal is to maximize UI testing while acknowledging these limitations and using direct API calls only when absolutely necessary.