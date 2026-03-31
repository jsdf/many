# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is a web application (with CLI) for managing Git worktree pools. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.
 
## Design Goals

- **Don't delete data without confirmation.** Destructive operations (cleaning worktree changes, discarding uncommitted work, archiving unmerged branches) should require explicit user confirmation or be clearly flagged. Automated flows should prefer skipping dirty worktrees over silently cleaning them.

## Development Commands

### Running the Application

- `npm run build` - Type-check and build the React frontend with Vite
- `npm run build:cli` - Build the server and CLI with TypeScript
- `npm start` - Build everything and start the web server
- `npm run dev` - Quick build frontend and start the web server
- `npm run cli` - Build and run the CLI tool
- `npm run test` - Run tests with Vitest

be sure to run `start` and `dev` using `timeout` because they are long running processes and you will time out waiting for them to finish if you run them normally


### Setup

- `npm install` - Install all dependencies

### Installing locally

To install the `many` CLI globally from your local checkout:

```sh
npm run build:cli && npm link
```

This builds the CLI and symlinks the `many` binary so it's available globally. Re-run after making changes to update.

To install the Electron app to the Applications folder:

```sh
npm run electron:install
```

### Build System

The project uses two build pipelines:

- **Vite** builds the React renderer → `out/renderer/`
- **TypeScript** (`tsc -p tsconfig.cli.json`) builds the server and CLI → `dist-cli/`

The web server (`dist-cli/web/server.js`) serves the built renderer static files and provides a tRPC API.

## Dev Processes
### testing changes

manually web ui test changes in the browser

### when changing services

don't forget to run and update tests, write new ones if new behaviors are specified

### after completing a task
dont forget to commit and  `npm run electron:install`

## Architecture Overview

### Web Server Architecture

**Web Server** (`src/web/server.ts`):

- HTTP server serving static files and tRPC API
- Handles all git operations via `src/cli/git-pool.ts`
- Manages persistent data storage via `src/cli/config.ts`
- External actions (open folder, editor, terminal) via `child_process`

**Renderer (React + TypeScript)**:

- `src/renderer/src/App.tsx` - Main application component and state management
- `src/renderer/src/main.tsx` - Entry point, tRPC client setup
- `src/renderer/src/components/` - React components
- Communicates with server via tRPC over HTTP

**CLI** (`src/cli/`):

- `src/cli/index.ts` - CLI entry point with commands: list, switch, create, release, archive, web
- `src/cli/ink-prompts.tsx` - Interactive terminal prompts using Ink
- `src/cli/git-pool.ts` - Git worktree pool management
- `src/cli/config.ts` - App data persistence

**Shared** (`src/shared/`):

- `src/shared/git-core.ts` - Core git operations used by both server and CLI
- `src/shared/git-core.test.ts` - Tests for git-core

### Debug Logging

Server-side debug logs are written to a log file via `src/shared/logger.ts`. Log location:

- macOS: `~/Library/Logs/many/many-<timestamp>.log`
- Windows: `%APPDATA%/many/logs/many-<timestamp>.log`
- Linux: `~/.local/state/many/logs/many-<timestamp>.log`

The log file path is printed at server startup. Keeps last 10 files, 10MB max each. Use `logger.debug/info/warn/error` — `warn` and `error` also print to console.

### Data Persistence

App data is stored in a platform-specific location:

- macOS: `~/Library/Application Support/many/app-data.json`
- Windows: `%APPDATA%/many/app-data.json`
- Linux: `~/.config/many/app-data.json`

```typescript
{
  repositories: [{ path, name, addedAt }],
  repositoryConfigs: { [repoPath]: { mainBranch, initCommand, worktreeDirectory, pools? } },
  selectedRepo: string | null,
  recentWorktrees: { [repoPath]: worktreePath },
  windowBounds: { width, height, x?, y? },
  globalSettings: { defaultEditor, defaultTerminal }
}
```

### UI Architecture

**Layout Structure**:

- Left sidebar: Repository selector, worktree list, action buttons
- Main content area: Split pane view
  - Left pane: Worktree details (overview, actions, git status, branch changes) — scrollable
  - Right pane: Terminal stack (vertically stacked terminals with resizable dividers)
  - Horizontal divider between panes is draggable to resize
- Modal overlays: Repository addition, worktree creation, merge, rebase, switch, release, global settings

**State Management**:

- React functional components with hooks
- tRPC client for server communication



## Multi-agent coordination

When multiple Claude Code agents work on this repo in parallel, use the `agent-status/` directory to coordinate and avoid conflicts.

### Protocol

1. **On start**: create `agent-status/<task-slug>.md` named after your task (e.g. `add-slack-ingester.md`, `fix-mail-timeout.md`) with:
   ```
   # <short task description>
   Status: in-progress
   Started: <timestamp>

   ## What I'm doing
   <brief description>

   ## Files I'm actively editing
   - path/to/file.ts
   - path/to/other.ts

   ## Files I'm done with
   (none yet)
   ```

2. **During work**: keep the file updated as you move between files. When you finish editing a file, move it from "actively editing" to "done with".

3. **On completion**: delete your status file.

4. **Before editing a file**: check if any other agent's status file lists it under "actively editing". If so, avoid editing that file — work on something else or wait. Files listed under "done with" are safe to edit.

5. **Periodically**: read other agents' status files to understand why files are changing around you. This avoids confusion when git shows unexpected diffs.

### Rules

- Never edit a file another agent is actively editing — this causes merge conflicts
- Files under "done with" are fair game
- If you need a file another agent owns, leave a note in your status file requesting it and check back later
- Keep status files minimal — just enough for other agents to know what's off-limits
- The `agent-status/` directory should be gitignored
