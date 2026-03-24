# WorktreeService Specification

This document specifies the behavior of the WorktreeService — the service layer that encapsulates worktree pool management business logic, consumed by both the web server (tRPC/SSE handlers) and the CLI.

## Design Principles

- **Transport-agnostic**: The service knows nothing about HTTP, SSE, or terminal I/O. Callers receive structured progress via an `onProgress` callback.
- **No interactive prompts**: The service does not prompt the user. Decisions (which worktree to use, how to handle dirty state) are made by the caller and passed as arguments.
- **Config is passed in**: The service does not load config from disk. Callers load `AppData`/`RepositoryConfig` and pass the relevant pieces. This keeps the service pure and testable.

## Progress Callback

Many operations accept an optional `onProgress` callback:

```typescript
type ProgressEvent =
  | { type: "step"; text: string }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; text: string };

type OnProgress = (event: ProgressEvent) => void;
```

If not provided, progress events are silently discarded.

---

## Operations

### getWorktrees

List all worktrees for a repository, enriched with pool metadata.

**Input**: `repoPath: string`

**Output**: `WorktreeInfo[]` where each entry contains:
- `path` — absolute path to the worktree directory
- `commit` — current HEAD commit hash
- `branch` — full branch ref (e.g. `refs/heads/feature-1`) or null
- `bare` — whether this is the bare repo entry
- `isAvailable` — true if on a `tmp-` prefixed branch (available in pool)
- `worktreeName` — short name extracted from the directory path

**Behavior**:
1. Run `git worktree prune` to clean stale entries.
2. Parse `git worktree list --porcelain`.
3. Enrich each entry: determine `isAvailable` from branch prefix, extract `worktreeName` by stripping the repo base name prefix from the directory name.

### getAvailableWorktrees

Return worktrees that are available in the pool (on a tmp branch, not bare).

**Input**: `repoPath: string`

**Output**: `WorktreeInfo[]` — subset of `getWorktrees` where `isAvailable && !bare`.

### getClaimedWorktrees

Return worktrees that are currently claimed (not on a tmp branch, not bare).

**Input**: `repoPath: string`

**Output**: `WorktreeInfo[]` — subset of `getWorktrees` where `!isAvailable && !bare`.

### findWorktree

Look up a worktree by branch name or worktree name.

**Input**: `repoPath: string`, `identifier: string`

**Output**: `WorktreeInfo | null`

**Behavior**:
1. Strip `refs/heads/` from identifier if present.
2. Search worktrees for a matching branch name (also stripping `refs/heads/` from each worktree's branch).
3. If no match, search by `worktreeName`.
4. Return first match or null.

### createWorktree

Create a new worktree in the pool on a temporary branch.

**Input**:
- `repoPath: string`
- `worktreeName: string`
- `config: { mainBranch: string | null; worktreeDirectory: string | null }`

**Output**: `{ path: string; branch: string }` — the created worktree path and its tmp branch name.

**Behavior**:
1. Compute the tmp branch name: `tmp-{worktreeName}`.
2. Compute the worktree path: `{worktreeDirectory || parent of repoPath}/{repoBaseName}-{worktreeName}`.
3. Resolve the default branch (from config or by detection).
4. If the tmp branch already exists: detach at its current commit, then force-checkout the branch (preserves prior state).
5. If the tmp branch does not exist: create it at the default branch head via `git worktree add -b`.

### claimWorktree

Transition a worktree from available to claimed by checking out a branch.

**Input**:
- `repoPath: string`
- `worktreePath: string`
- `branchName: string`
- `mainBranch: string | null`
- `pullLatest: boolean` (default: true)

**Output**: `string` — the branch name that was checked out.

**Behavior**:
1. Verify the worktree directory exists.
2. If `pullLatest`, fetch the branch from `origin` (ignore errors — may be offline or branch may not exist remotely).
3. Check if the branch exists locally and/or on `origin`:
   - **Local exists**: checkout the branch. If `pullLatest` and remote exists, `reset --hard origin/{branch}` to update (ignore errors if diverged).
   - **Remote exists but not local**: create local tracking branch from `origin/{branch}`.
   - **Neither exists**: create a new branch from the default branch. If `pullLatest`, fetch the default branch first.

### releaseWorktree

Release a claimed worktree back to the pool by switching it to a tmp branch.

**Input**:
- `repoPath: string`
- `worktreePath: string`
- `mainBranch: string | null`
- `force: boolean` (default: false)

**Output**: `{ tmpBranch: string; previousBranch: string }`

**Behavior**:
1. Verify the worktree directory exists.
2. Get the current branch name (the "previous" branch).
3. Compute the tmp branch name: `tmp-{worktreeName}`.
4. Resolve the default branch and fetch it from origin (ignore errors).
5. Determine target commit: `origin/{defaultBranch}`, falling back to local `{defaultBranch}`.
6. Switch to the tmp branch at the target commit:
   - **Normal mode**: `git switch --force-create {tmpBranch} {targetCommit}`.
   - **Force mode**: directly move the branch ref and update HEAD via `symbolic-ref` (bypasses checkout/submodule issues).

**Note**: The previous branch is NOT deleted — it remains in git and can be reclaimed later.

### archiveWorktree

Remove a worktree directory and clean up git references. Optionally checks merge status first.

**Input**:
- `repoPath: string`
- `worktreePath: string`
- `options: { force?: boolean; mainBranch?: string | null }`

**Output**: `void`

**Behavior**:
1. If `!force` and `mainBranch` is provided:
   - Look up the worktree's current branch from `git worktree list`.
   - Check if that branch is fully merged into `mainBranch`.
   - If not merged, throw an error with prefix `UNMERGED_BRANCH:`.
   - If the merge check itself fails, throw with prefix `MERGE_CHECK_FAILED:`.
2. Remove the worktree via `git worktree remove --force`.
3. If that fails, fall back to: delete directory, then `git worktree prune`.

**Note**: The branch itself is preserved in git — only the worktree directory is removed.

### resolveStartingPoint

Resolve a user-provided starting point (branch name, PR number, or PR URL) to a branch name, fetching it from the remote.

**Input**:
- `repoPath: string`
- `startingPoint: string`
- `onProgress?: OnProgress`

**Output**: `string` — the resolved branch name.

**Behavior**:
1. Trim the input.
2. Try to parse as:
   - GitHub PR URL: `github.com/{owner}/{repo}/pull/{number}` → extract PR number
   - Graphite PR URL: `graphite.dev/github/pr/{owner}/{repo}/{number}` → extract PR number
   - Plain PR number: `#123` or `123` → extract number
3. If a PR number was extracted:
   - Run `gh pr view {number} --json headRefName --jq .headRefName` to get the branch name.
   - Throw if the branch name is empty.
4. Otherwise, treat the input as a literal branch name.
5. Fetch the branch from origin. If fetch fails:
   - Check if the branch exists locally or as `remotes/origin/{branch}`.
   - If not found anywhere, throw.
   - Report via `onProgress` that the branch is local-only.
6. Report the resolved branch via `onProgress`.

### createAndSetupWorktree

Compound workflow: create a worktree, optionally resolve a starting point, claim for a branch, and run an init command.

**Input**:
- `repoPath: string`
- `options`:
  - `worktreeName: string`
  - `startingPoint?: string` — branch, PR number, or PR URL
  - `poolPrefix?: string` — if provided, prepends to worktreeName
  - `pullLatest?: boolean` (default: true)
  - `initCommand?: string | null`
  - `mainBranch: string | null`
  - `worktreeDirectory: string | null`
- `onProgress?: OnProgress`
- `runCommand: (command: string, cwd: string, onProgress?: OnProgress) => Promise<number>` — caller-provided command runner (allows server to pipe stdout/stderr, CLI to use `stdio: "inherit"`, tests to mock)

**Output**: `{ worktreePath: string; branch: string }`

**Behavior**:
1. If `startingPoint` is provided, call `resolveStartingPoint`.
2. Compute effective worktree name (prepend `poolPrefix-` if given).
3. Call `createWorktree`.
4. If a branch was resolved, claim the worktree for that branch.
5. If `initCommand` is configured, run it in the worktree via `runCommand`. Non-zero exit is reported but does not fail the operation.
6. Return the worktree path and final branch.

### launchTask

Compound workflow: acquire a worktree (from pool or create ephemeral), optionally resolve a starting point, run maintenance/init, and register a task.

**Input**:
- `repoPath: string`
- `options`:
  - `poolType: "recyclable" | "ephemeral"`
  - `poolPrefix: string`
  - `prompt: string`
  - `startingPoint?: string`
  - `maintenanceCommand?: string`
  - `initCommand?: string | null`
  - `mainBranch: string | null`
  - `worktreeDirectory: string | null`
  - `taskCommand?: string`
  - `launchedBy: "cli" | "web"`
  - `logFile?: string`
- `onProgress?: OnProgress`
- `runCommand: (command: string, cwd: string, onProgress?: OnProgress) => Promise<number>`

**Output**: `{ worktreePath: string; branch: string; taskRecord: TaskRecord }`

**Behavior**:

1. If `startingPoint` is provided, call `resolveStartingPoint`.

2. **Recyclable pool path**:
   a. Find an available worktree whose `worktreeName` starts with `poolPrefix` (excluding the base repo and bare entries).
   b. If none available, report error and throw.
   c. Generate a branch name: use `resolvedBranch` if available, otherwise derive from prompt: `task/{first 40 chars, slugified}-{timestamp base36}`.
   d. Claim the worktree for that branch.
   e. If `maintenanceCommand` is provided, run it via `runCommand`. Non-zero exit is reported but does not fail.
   f. `worktreePath` = the claimed worktree's path.

3. **Ephemeral pool path**:
   a. Generate a worktree name: `{poolPrefix}-{timestamp base36}`.
   b. Call `createWorktree` with that name.
   c. If a branch was resolved, claim the worktree for it.
   d. If `initCommand` is configured, run it via `runCommand`. Non-zero exit is reported but does not fail.
   e. `worktreePath` = the newly created worktree's path.

4. Register a task record via the task registry with:
   - `pid: 0` (actual PID is set by the caller after spawning the process)
   - `repoPath`, `worktreePath`, `poolPrefix`, `branch`, `prompt`, `taskCommand`, `launchedBy`, `logFile`
   - `status: "running"`, `startedAt: now`

5. Return the worktree path, branch, and task record.

**Note**: The service does NOT spawn the task process itself. It prepares the worktree and registers the task — the caller handles process spawning (since the server and CLI have different spawning strategies: piped stdout vs TTY with `script`).

---

## Operations NOT in the service

The following remain in their current locations:

### Stays in git-core.ts (low-level git primitives)
- `parseWorktreeList` — raw git porcelain parsing
- `getDefaultBranch` — branch detection heuristic
- `branchExists` — branch existence check
- `getWorktreeStatus` — git status parsing
- `checkBranchMerged` — merge-base comparison
- `removeWorktree` — worktree directory + git ref cleanup
- `stashChanges`, `cleanChanges`, `amendChanges`, `commitChanges` — change management
- `claimWorktree`, `releaseWorktree` — low-level branch switching
- Pure utilities: `extractWorktreeName`, `isTmpBranch`, `getLocalBranchName`, `getErrorMessage`

### Stays in git-pool.ts (pool-aware wrappers)
- Thin wrappers that adapt `RepositoryConfig` → `mainBranch: string | null` for git-core calls
- `WorktreeInfo` type definition
- `getWorktrees`, `getAvailableWorktrees`, `getClaimedWorktrees`, `findWorktree` — may move to service or stay here depending on whether the service delegates or replaces

### Stays in task-registry.ts (persistence)
- `registerTask`, `updateTaskStatus`, `updateTaskPid`, `markTaskCompleted`
- `listTasks`, `getTask`, `killTask`, `reconcileTasks`, `pruneOldTasks`
- File locking, registry load/save

### Stays in config.ts (persistence)
- `loadAppData`, `saveAppData`, `getRepoConfig`, `getGlobalSettings`
- Type definitions: `AppData`, `RepositoryConfig`, `PoolConfig`, `GlobalSettings`

### Stays in server.ts (transport/UI concerns)
- SSE response setup, token auth, static file serving
- Terminal manager lifecycle
- External actions (open in editor/terminal/file manager)
- GitHub link resolution (PR URL lookup via `gh`)
- tRPC router definition — each handler becomes a thin wrapper calling the service

### Stays in CLI index.ts (interactive UI concerns)
- Interactive prompts and user selection (Ink)
- Flag parsing and validation
- Dirty state handling UI (prompt user for stash/commit/amend/clean/cancel)
- Target worktree selection logic (current worktree detection, picker UI)
- Output formatting (colors, status display)

---

## Dirty State Handling

The service does NOT handle dirty state decisions. The caller is responsible for:
1. Checking `getWorktreeStatus` before calling `claimWorktree` or `releaseWorktree`.
2. Deciding what to do (stash, commit, amend, clean, abort).
3. Calling the appropriate change management function (`stashChanges`, `cleanChanges`, etc.).
4. Then calling the service operation.

This keeps the interactive prompting (CLI) and confirmation dialogs (web UI) out of the service layer.

---

## Error Handling

- Service methods throw on failure with descriptive error messages.
- The `archiveWorktree` method uses error message prefixes (`UNMERGED_BRANCH:`, `MERGE_CHECK_FAILED:`) to allow callers to distinguish between "not merged" and "couldn't check."
- `resolveStartingPoint` throws if the branch cannot be found locally or remotely.
- `launchTask` throws if no available worktree is found in a recyclable pool.
- Non-fatal issues (init command non-zero exit, fetch failures when offline) are reported via `onProgress` but do not throw.
