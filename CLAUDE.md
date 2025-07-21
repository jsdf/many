# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Many Worktree Manager is an Electron desktop application for managing Git worktrees. It allows developers to create and organize multiple worktrees for parallel development workflows, for example running many instances of Claude Code in parallel to work on implementing features, without interfering with each other.

Features

- add/manage repos
- lists worktrees in the left sidebar
- clicking a worktree in the sidebar shows it in the main pane
- create worktree (along with a corresponding git branch)
- create a worktree from an existing git branch
- archive worktree (deletes the file tree, though it still exists as a branch in git)
- features of the main pane
  - a menu of tools to open the worktree in
    - open folder
    - open in terminal
    - open in editor
  - an integrated terminal, so you can use claude or run commands
    - ability to create more terminals, so you can have one running claude and another running the app or doing a git command
    - clickable links in terminal output
  - an integrated review tool of the git changes on the branch
- per repo settings
  - command to init a new worktree (e.g. `npm install`)
  - commands to show as buttons to run in worktree (think vscode tasks.json, could also automatically support package.json scripts)

## Development Commands

### Running the Application

- `npm start` - Launch the application in production mode
- `npm run dev` - Launch in development mode with DevTools enabled

### Building and Distribution

- `npm run build` - Build distributable application using electron-builder
- `npm run pack` - Package application without creating installer
- `npm run dist` - Create full distribution packages

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

- `src/main.js` - Main process, IPC handlers, Git operations
- `src/preload.js` - Security bridge, API exposure
- `src/renderer.js` - UI logic, event handling, state management
- `src/index.html` - UI structure and modals
- `src/styles.css` - Dark theme styling, responsive design
- `src/logo.png` - Application icon

### AI Integration Pattern

The application converts user prompts into Git branch names:

1. User enters natural language description
2. Text sanitization removes special characters
3. Conversion to kebab-case format
4. Username prefix addition
5. Branch and worktree creation

This enables intuitive worktree creation for AI-assisted development workflows where multiple features are developed in parallel.
