# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is a web application (with CLI) for managing Git worktree pools. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.
 
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
