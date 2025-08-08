# Testing with Isolated Environments

This document explains how to use the isolated testing environment system for the Many Worktree Manager application.

## Overview

The testing system now provides isolated data and log paths for each test, ensuring:
- Tests don't interfere with each other
- No pollution of production data
- Clean state for each test
- Easy log analysis for error detection

## Basic Usage

### Using the Isolated Test Fixture

```typescript
import { test, expectNoErrors } from './test-utils';

test('My test with isolation', async ({ isolatedApp }) => {
  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../out/main/index.cjs')],
    env: {
      ...process.env,
      TEST_DATA_PATH: isolatedApp.dataPath,
      TEST_LOG_PATH: isolatedApp.logPath
    }
  });
  
  // ... your test logic
  
  await electronApp.close();
  
  // Check for errors in logs
  await expectNoErrors(isolatedApp.logPath);
});
```

### Manual Isolation Setup

```typescript
import { createIsolatedTestEnv } from './test-utils';

const testEnv = await createIsolatedTestEnv();
// Use testEnv.dataPath and testEnv.logPath
await testEnv.cleanup();
```

## Log Analysis

### Reading Logs

```typescript
import { readErrorLogs, parseLogEntry, checkForErrors } from './test-utils';

// Read all log entries
const logs = await readErrorLogs(isolatedApp.logPath);

// Parse individual entries
const entries = logs.map(parseLogEntry).filter(Boolean);

// Check for errors
const { hasErrors, errorLogs, matchedPatterns } = checkForErrors(logs, ['pattern1', 'pattern2']);
```

### Log Entry Format

Log entries follow this format:
```
[2024-01-01T12:00:00.000Z] SOURCE_NAME: Error message or details
```

### Checking for Specific Errors

```typescript
// Look for specific error patterns
const tRPCErrors = logs.filter(log => 
  log.includes('tRPC') && 
  (log.includes('error') || log.includes('failed'))
);

// Wait for a specific log entry
const entry = await waitForLogEntry(logPath, 'APP_START', 5000);
```

## Configuration System

The app uses environment variables for test configuration:

- `TEST_DATA_PATH`: Override app data storage location
- `TEST_LOG_PATH`: Override log file location

These are automatically set by the test fixture.

## File Structure

- `tests/test-utils.ts`: Core testing utilities
- `tests/app-isolated.electron.spec.ts`: Example isolated tests
- `tests/error-handling-isolated.electron.spec.ts`: Error handling examples
- `src/main/config.ts`: Configuration management
- `src/main/logger.ts`: Updated logging with path overrides

## Best Practices

### 1. Always Use Isolated Environments for E2E Tests

```typescript
// ✅ Good
test('My test', async ({ isolatedApp }) => {
  // Test logic
});

// ❌ Bad - may interfere with other tests or production data
test('My test', async () => {
  // Test logic without isolation
});
```

### 2. Check Logs After Each Test

```typescript
test('Repository operations', async ({ isolatedApp }) => {
  // ... test repository operations
  await electronApp.close();
  
  // Verify no errors occurred
  await expectNoErrors(isolatedApp.logPath);
});
```

### 3. Test Error Scenarios

```typescript
test('Error handling', async ({ isolatedApp }) => {
  // ... trigger error conditions
  
  const logs = await readErrorLogs(isolatedApp.logPath);
  const expectedErrors = logs.filter(log => log.includes('EXPECTED_ERROR'));
  expect(expectedErrors.length).toBeGreaterThan(0);
});
```

### 4. Clean Up Resources

The test fixture automatically cleans up, but for manual setups:

```typescript
const testEnv = await createIsolatedTestEnv();
try {
  // Test logic
} finally {
  await testEnv.cleanup();
}
```

## Debugging

### View Test Logs

Logs are written to temporary directories like `/tmp/many-test-abc123/logs/electron-errors.log`.

### Enable Verbose Logging

```typescript
// In tests, check all log entries
const logs = await readErrorLogs(isolatedApp.logPath);
console.log('All logs:', logs);
```

### Check Specific Error Types

```typescript
// Filter for specific error sources
const rendererErrors = logs.filter(log => log.includes('RENDERER_'));
const mainProcessErrors = logs.filter(log => log.includes('UNCAUGHT_EXCEPTION'));
```

## Environment Variables for Development

You can also use these environment variables when running the app manually for testing:

```bash
TEST_DATA_PATH=/tmp/my-test-data TEST_LOG_PATH=/tmp/my-test-logs npm start
```

This allows you to test with isolated environments even during development.