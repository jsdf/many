# Many - Worktree Manager

![logo](public/many-shodan.png)

A modern Electron desktop application for managing Git worktrees, designed for parallel development workflows with AI tools like Claude Code.

## Features

- **Worktree Creation & Management** - Create new worktrees with automatic branch creation
- **Integrated Workflow** - Designed to work seamlessly with AI development tools
- **Cross-Platform** - Works on macOS, Windows, and Linux

## Getting Started

No builds offered yet, for now checkout and use `npm run build` to build the app.

## Usage

### Adding a Repository

1. Click "Add Repo" in the sidebar
2. Browse to or enter the path of your Git repository
3. Click "Add Repository"

### Creating Worktrees

1. Select a repository from the dropdown
2. Click "Create Worktree"
3. Enter a branch name (e.g., "fix-login-bug", "add-dark-mode")
4. The app will create both the branch and worktree automatically

### Working with Worktrees

- Click on any worktree in the sidebar to view its details
- Each worktree is created in a parallel directory structure
- Perfect for running multiple instances of development tools simultaneously

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
