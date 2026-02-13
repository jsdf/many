# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is a web application (with CLI) for managing Git worktrees. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.

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
- [ ] features of the main pane
  - [ ] a menu of tools to open the worktree in
    - [x] open folder
    - [x] open in terminal
    - [x] open in editor
    - [ ] npm scripts
  - [ ] an integrated review tool of the git changes on the branch
- [ ] per repo settings
  - [x] command to init a new worktree (e.g. `npm install`)
  - [ ] commands to show as buttons to run in worktree (think vscode tasks.json, could also automatically support package.json scripts)
- [ ] watch git repo for changes and live update

  - [ ] worktrees list/checked out branch name
  - [ ] git changes on worktree

- [ ] bugs

  - [ ] very long branch names overflow their container in the left nav. truncate them with ellipses and show a tooltip

- chores
  - [ ] split components and css into reasonable modules
    - [x] too many components in MainContent.tsx
    - [ ] split styles.css based on components which use classes
    - [ ] split modal code from components which render modals
  - [x] split backend into reasonable modules
    - [x] git stuff should be in its own file
    - [x] external app actions should be in their own file
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

be sure to run `start` and `dev` using `timeout` because they are long running processes and you will time out waiting for them to finish if you run them normally

### Setup

- `npm install` - Install all dependencies

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

- `src/cli/index.ts` - CLI entry point
- `src/cli/git-pool.ts` - Git worktree pool management
- `src/cli/config.ts` - App data persistence

**Shared** (`src/shared/`):

- `src/shared/git-core.ts` - Core git operations used by both server and CLI

### Data Persistence

App data is stored in `~/.config/many/app-data.json`:

```javascript
{
  repositories: [{ path, name, addedAt }],
  selectedRepo: string | null,
  repositoryConfigs: { [repoPath]: { mainBranch, initCommand, worktreeDirectory } },
  recentWorktrees: { [repoPath]: worktreePath }
}
```

### UI Architecture

**Layout Structure**:

- Left sidebar: Repository selector, worktree list, action buttons
- Main content area: Worktree details or welcome screen
- Modal overlays: Repository addition, worktree creation, merge, rebase

**State Management**:

- React functional components with hooks
- tRPC client for server communication

### File Structure Conventions

**Renderer Process (React + TypeScript)**:

- `src/renderer/src/App.tsx` - Main application component and state management
- `src/renderer/src/components/` - React components:
  - `Sidebar.tsx` - Repository selector, worktree list
  - `MainContent.tsx` - Worktree details and actions
  - `WorktreeDetails.tsx` - Worktree detail view
  - `CreateWorktreeModal.tsx` - Worktree creation dialog
  - `AddRepoModal.tsx` - Repository addition and configuration
  - `MergeWorktreeModal.tsx` - Branch merging interface
- `src/renderer/src/types.ts` - TypeScript type definitions
- `src/renderer/index.html` - Main HTML structure
- `src/renderer/src/styles.css` - Dark theme styling, responsive design
