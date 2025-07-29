# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is an Electron desktop application for managing Git worktrees. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.

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
  - [ ] an integrated terminal, so you can use claude or run commands
    - [ ] ability to create more terminals, so you can have one running claude and another running the app or doing a git command
    - [ ] clickable links in terminal output
  - [ ] an integrated review tool of the git changes on the branch
- [ ] per repo settings
  - [x] command to init a new worktree (e.g. `npm install`)
  - [ ] commands to show as buttons to run in worktree (think vscode tasks.json, could also automatically support package.json scripts)
- [ ] watch git repo for changes and live update

  - [ ] worktrees list/checked out branch name
  - [ ] git changes on worktree

- [ ] bugs

  - [x] the terminals need to be owned by worktrees, so when you switch worktree panes it shows terminals owned by that worktree. currently they are shared
  - [ ] initialization command doesn't seem to work
  - [x] archive worktree doesn't seem to work: `Error invoking remote method 'archive-worktree': Error: error: failed to delete '/Users/jsdf/code/clay-base-tiptap-before': Directory not empty.`. it's expected that archiving a worktree would delete the dir, maybe that is all that needs to happen?
  - [ ] very long branch names overflow their container in the left nav. truncate them with ellipses and show a tooltip
  - [x] no maximum terminal history, leaks memory. should be configurable, defaulting to 5k lines. also is string the optimal storage for this?

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

- `npm run build` if you want to check for errors without actually running the app

be sure to run these in the background e.g. with `&` because they are long running processes and you will time out waiting for them to finish if you run them normally

- `npm start` - Launch the application in production mode
- `npm run dev` - Launch in development mode with DevTools enabled

### Building and Distribution

- `npm run build` - Compile the application source code (no installers)
- `npm run pack` - Build and package application without creating installer
- `npm run dist` - Build and create full distribution packages (DMG, zip, etc.)

### Setup

- `npm install` - Install all dependencies

## Architecture Overview

### Electron Multi-Process Architecture

**Main Process** (`src/main.js`):

- Manages application lifecycle and native system interactions
- Handles IPC communication with renderer process
- Manages persistent data storage in `app-data.json`
- Executes Git operations using `simple-git` library
- Controls window creation, sizing, and positioning

**Preload Script** (`src/preload.js`):

- Secure bridge between main and renderer processes
- Exposes curated API via `contextBridge` for safety
- No direct Node.js access from renderer

**Renderer Process** (`src/renderer.js`):

- Frontend application logic in `WorktreeManager` class
- Event-driven UI management and user interactions
- Communicates with main process via IPC calls

### Data Persistence

App data is stored in platform-specific user data directory using Electron's `app.getPath('userData')`:

```javascript
// Default structure in app-data.json
{
  repositories: [{ path, name, addedAt }],
  selectedRepo: string | null,
  windowBounds: { width, height, x?, y? }
}
```

### IPC Communication Pattern

The application uses secure IPC handlers in main process:

- `get-worktrees` - List worktrees for repository
- `create-worktree` - Create new worktree with AI branch naming
- `get-git-username` - Retrieve Git username from config
- `get-saved-repos` / `save-repo` - Repository persistence
- `get-selected-repo` / `set-selected-repo` - State persistence
- `select-folder` - Native folder picker dialog

### Git Worktree Management

**Branch Naming Convention**: `{username}/{sanitized-prompt}`

- User prompts are sanitized (lowercase, alphanumeric + hyphens, max 50 chars)
- Git username automatically retrieved from repository config
- Worktrees created in parallel directory structure

**Git Operations**:

- Uses `simple-git` library for all Git interactions
- Parses `git worktree list --porcelain` output for worktree information
- Atomic worktree creation (branch + worktree in single operation)

### UI Architecture

**Layout Structure**:

- Left sidebar: Repository selector, worktree list, action buttons
- Main content area: Welcome screen with feature highlights
- Modal overlays: Repository addition and worktree creation

**State Management**:

- Class-based component with centralized state in `WorktreeManager`
- Event-driven updates with comprehensive error handling
- Real-time persistence of user selections and window state

## Key Development Patterns

### Security Implementation

- `nodeIntegration: false` and `contextIsolation: true` in webPreferences
- All Node.js operations restricted to main process
- Secure IPC communication via preload script bridge

### Error Handling

- Try-catch blocks around all async operations
- User-friendly error messages via modal alerts
- Graceful fallbacks for missing/corrupted data files

### File Structure Conventions

The application uses a modern Electron + React + TypeScript architecture:

**Main Process**:

- `src/main/index.ts` - Main process, IPC handlers, Git operations

**Preload Scripts**:

- `src/preload/index.ts` - Security bridge, API exposure

**Renderer Process (React + TypeScript)**:

- `src/renderer/src/App.tsx` - Main application component and state management
- `src/renderer/src/components/` - React components:
  - `Sidebar.tsx` - Repository selector, worktree list
  - `MainContent.tsx` - Worktree details and actions
  - `CreateWorktreeModal.tsx` - Worktree creation dialog
  - `AddRepoModal.tsx` - Repository addition and configuration
  - `MergeWorktreeModal.tsx` - Branch merging interface
- `src/renderer/src/types.ts` - TypeScript type definitions
- `src/renderer/index.html` - Main HTML structure
- `src/renderer/src/styles.css` - Dark theme styling, responsive design

### AI Integration Pattern

The application converts user prompts into Git branch names:

1. User enters natural language description
2. Text sanitization removes special characters
3. Conversion to kebab-case format
4. Username prefix addition
5. Branch and worktree creation

This enables intuitive worktree creation for AI-assisted development workflows where multiple features are developed in parallel.

## End-to-End Test Scenarios

### Core Repository Management Tests

- [ ] Add repository via folder picker dialog
- [ ] Verify repository appears in sidebar after adding
- [ ] Test invalid/non-git directories are rejected
- [ ] Test duplicate repository prevention
- [ ] Select different repositories from dropdown
- [ ] Verify repository selection persists across app restarts
- [ ] Test empty state when no repositories exist

### Worktree Lifecycle Tests

- [ ] Create worktree with custom branch name
- [ ] Create worktree from existing branch
- [ ] Verify AI-generated branch naming (`{username}/{sanitized-prompt}`)
- [ ] Test branch name sanitization (special chars, length limits)
- [ ] Verify worktree appears in sidebar immediately after creation
- [ ] Click worktree in sidebar shows details in main pane
- [ ] Verify worktree metadata display (branch, path, status)
- [ ] Test very long branch names are truncated with ellipses and tooltip
- [ ] Verify base/main worktree shows first with "base" tag
- [ ] Archive merged worktree (should succeed without prompt)
- [ ] Archive unmerged worktree (should show confirmation dialog)
- [ ] Verify directory deletion after archiving
- [ ] Test cleanup of worktree references after archiving

### External Tool Integration Tests

- [ ] Open worktree folder in file manager
- [ ] Open worktree in terminal
- [ ] Open worktree in configured editor
- [ ] Test behavior with missing/invalid external tools

### Terminal Integration Tests

- [ ] Create terminal in worktree context
- [ ] Verify terminal opens in correct worktree directory
- [ ] Test multiple terminals per worktree
- [ ] Switch between worktrees preserves terminal isolation
- [ ] Test terminal memory limits (5k line history)
- [ ] Verify clickable links in terminal output work
- [ ] Test terminal persistence across app sessions

### Configuration & Settings Tests

- [ ] Configure initialization command for new worktrees
- [ ] Test initialization command execution on worktree creation
- [ ] Configure custom commands/scripts per repository
- [ ] Verify settings persist per repository
- [ ] Test settings migration/compatibility

### Git Operations Tests

- [ ] Create worktree creates corresponding git branch
- [ ] Merge branch workflow via integrated review tool
- [ ] Test merge conflict detection and handling
- [ ] Verify branch status tracking (ahead/behind/merged)
- [ ] Live update worktree list when git changes occur externally
- [ ] Update branch names when changed outside app
- [ ] Detect new/deleted worktrees from external git commands

### Data Persistence Tests

- [ ] Window bounds persistence across restarts
- [ ] Repository list persistence
- [ ] Selected repository persistence
- [ ] Terminal history persistence per worktree
- [ ] Worktree state persistence

### Error Handling Tests

- [ ] Handle corrupted `app-data.json` gracefully
- [ ] Git command failures (network issues, permissions)
- [ ] Missing git executable error handling
- [ ] Worktree directory deletion outside app
- [ ] Repository moved/deleted externally
- [ ] Long-running operations with user feedback
- [ ] Network connectivity issues during git operations

### Performance Tests

- [ ] Multiple repositories with many worktrees
- [ ] Large terminal output handling
- [ ] Memory usage with long-running terminals
- [ ] Git operations on large repositories
- [ ] App startup time with many repositories

### UI/UX Tests

- [ ] Add repository modal validation and error states
- [ ] Create worktree modal validation and error states
- [ ] Confirmation dialogs (archive, destructive actions)
- [ ] Modal keyboard navigation and escape handling
- [ ] Sidebar resize behavior
- [ ] Window resizing maintains layout
- [ ] Overflow handling in worktree list
- [ ] Dark theme consistency across all components
