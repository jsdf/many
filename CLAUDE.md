# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is a web application (with CLI) for managing Git worktree pools. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.

Features/TODO

- [x] add/manage repos
- [x] lists worktrees in the left sidebar
  - [ ] show repo base/main worktree first and show a tag which says 'base'
- [x] clicking a worktree in the sidebar shows it in the main pane
- [x] create worktree (along with a corresponding git branch)
- [x] create a worktree from an existing git branch
- [x] archive worktree (deletes the file tree, though it still exists as a branch in git)
  - [x] checks if branch is fully merged into main branch before archiving
  - [x] prompts user for confirmation if branch is not merged
- [x] claim/release worktrees (worktree pool workflow)
- [x] multiple named pools per repo (prefix-based grouping, recyclable/ephemeral types, maintenance commands)
- [x] switch worktree to a different branch
- [x] rebase worktree branch onto main
- [x] merge worktree branch into main
- [x] release base worktree
- [x] git status display in worktree details
- [x] global settings (default editor, default terminal)
- [ ] features of the main pane
  - [x] a menu of tools to open the worktree in
    - [x] open folder
    - [x] open in terminal
    - [x] open in editor (VS Code)
    - [ ] npm scripts
  - [ ] an integrated review tool of the git changes on the branch
- [x] per repo settings
  - [x] command to init a new worktree (e.g. `npm install`)
  - [x] worktree directory location
  - [x] main branch configuration
  - [ ] commands to show as buttons to run in worktree (think vscode tasks.json, could also automatically support package.json scripts)
- [ ] watch git repo for changes and live update
  - [ ] worktrees list/checked out branch name
  - [ ] git changes on worktree
- [ ] bugs
  - [ ] very long branch names overflow their container in the left nav. truncate them with ellipses and show a tooltip
- chores
  - [x] too many components in MainContent.tsx (split into separate component files)
  - [ ] split styles.css based on components which use classes
  - [ ] split modal code from components which render modals
  - [x] split backend into reasonable modules
  - [x] clean up repetitive code in App.tsx archiveWorktree() function
- large improvements
  - [ ] convert to using tailwind and shadcn/ui

don't forget to update this list if you finish implementing a feature

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

### Build System

The project uses two build pipelines:

- **Vite** builds the React renderer → `out/renderer/`
- **TypeScript** (`tsc -p tsconfig.cli.json`) builds the server and CLI → `dist-cli/`

The web server (`dist-cli/web/server.js`) serves the built renderer static files and provides a tRPC API.

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

### File Structure Conventions

**Renderer Process (React + TypeScript)**:

- `src/renderer/src/App.tsx` - Main application component and state management
- `src/renderer/src/main.tsx` - Entry point, tRPC client setup
- `src/renderer/src/types.ts` - TypeScript type definitions
- `src/renderer/index.html` - Main HTML structure
- `src/renderer/src/styles.css` - Dark theme styling, responsive design
- `src/renderer/src/components/` - React components:
  - `Sidebar.tsx` - Repository selector, worktree list
  - `MainContent.tsx` - Split pane layout: left (WorktreeDetails) + right (TerminalStack), with draggable divider
  - `WorktreeDetails.tsx` - Worktree detail view with actions
  - `TerminalStack.tsx` - Vertically stacked terminals with resizable dividers
  - `WelcomeScreen.tsx` - Welcome/empty state view
  - `CreateWorktreeModal.tsx` - Worktree creation dialog
  - `AddRepoModal.tsx` - Repository addition and configuration
  - `MergeWorktreeModal.tsx` - Branch merging interface
  - `RebaseWorktreeModal.tsx` - Branch rebasing interface
  - `SwitchWorktreeModal.tsx` - Branch switching interface
  - `ReleaseWorktreeModal.tsx` - Worktree release with dirty state handling
  - `GlobalSettingsModal.tsx` - Global settings (editor, terminal)
