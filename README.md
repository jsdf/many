# Many - Worktree Manager

![logo](public/many-shodan.png)

A web application and CLI for managing Git worktree pools, designed for parallel development workflows with AI tools like Claude Code.

## Features

- **Worktree Pool Management** - Create pools of worktrees, claim/release them for tasks
- **Web UI** - Browser-based interface for managing repos and worktrees
- **CLI** - Full-featured command-line interface with interactive prompts (powered by Ink)
- **Branch Operations** - Create, switch, merge, rebase, and archive branches
- **External Tool Integration** - Open worktrees in your editor, terminal, or file manager
- **Multi-Repo Support** - Manage worktree pools across multiple repositories
- **Per-Repo Configuration** - Set main branch, init commands, and worktree directory per repo

## Getting Started

```bash
npm install
npm start        # Build and start the web server
```

Or use the CLI directly:

```bash
npm run cli -- list          # List worktrees
npm run cli -- switch feat   # Claim a worktree and switch to branch
npm run cli -- create feat   # Create a new worktree
npm run cli -- release       # Release a worktree back to the pool
```

## CLI Usage

```
many <command> [options]

Commands:
  list (ls)            List all worktrees and their status
  switch [branch]      Claim a worktree and checkout the branch
  create <name>        Create a new worktree
  release [branch]     Release a worktree back to the pool
  archive [branch]     Remove a worktree directory (keeps branch in git)
  web                  Start the web UI
  version              Show the CLI version

Flags:
  --repo, -r <path>    Specify which repository
  --worktree, -w       Select which worktree
  --no-interactive     Exit with error if prompt needed
  --clean              Discard uncommitted changes
  --stash              Stash uncommitted changes
  --commit "message"   Commit changes
  --amend              Amend to last commit
  --force, -f          Skip merge checks (archive)
  --fail-if-dirty      Exit with error if dirty
  --port, -p <number>  Web server port
  --open, -o           Open browser automatically
```

## Web UI Usage

### Adding a Repository

1. Click "Add Repo" in the sidebar
2. Enter the path of your Git repository
3. Configure main branch, init command, and worktree directory

### Managing Worktrees

- Select a repository from the dropdown
- Click "Create Worktree" to create a new worktree with a branch
- Click any worktree in the sidebar to view details and actions
- Use the action buttons to open in editor, terminal, merge, rebase, switch, or release

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
