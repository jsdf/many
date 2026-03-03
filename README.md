# Many - Git Worktree Pool Manager

![logo](public/many-shodan.png)

A CLI and web UI for managing Git worktree pools, designed for parallel development workflows with AI tools like Claude Code.

## Install

```bash
npm install -g @jsdf/many
```

## Quick Start

```bash
many create worker-1          # Create a worktree
many create worker-2          # Create another
many switch feature/login     # Claim a worktree for a branch
many list                     # See all worktrees and their status
many release                  # Release current worktree back to the pool
many web                      # Open the web UI
```

## CLI Reference

```
many <command> [args] [flags]
```

### Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `list` | `ls` | List all worktrees and their status (default command) |
| `stat` | | Show worktrees with git status and diverged commits |
| `switch [branch]` | `sw` | Claim a worktree and checkout the branch. Creates branch if it doesn't exist |
| `create <name>` | `new` | Create a new worktree. Runs configured init command if any |
| `release [branch\|name]` | `rel` | Release a worktree back to the pool. Handles uncommitted changes interactively |
| `archive [branch\|name]` | `ar` | Remove a worktree directory (keeps branch in git). Checks merge status first |
| `web` | | Start the web UI in your browser |
| `version` | `-v` | Show the CLI version |
| `help` | `-h` | Show help |

### Flags

| Flag | Description | Used by |
|------|-------------|---------|
| `--repo, -r <path>` | Specify which repository to operate on | all |
| `--worktree, -w <name>` | Select which worktree | switch, release |
| `--no-interactive` | Exit with error if a prompt would be shown, with a message explaining which flags to provide | all |
| `--clean` | Discard uncommitted changes | switch, release |
| `--stash` | Stash uncommitted changes | release |
| `--commit "message"` | Commit uncommitted changes | release |
| `--amend` | Amend uncommitted changes to last commit | release |
| `--force, -f` | Skip merge checks and confirmation | archive |
| `--fail-if-dirty` | Exit with error if uncommitted changes exist | switch, release |
| `--port, -p <number>` | Web server port | web |
| `--no-open` | Don't open browser automatically | web |

### Examples

```bash
# Basic workflow
many list                           # Show all worktrees
many stat                           # Show worktrees with uncommitted changes
many switch feature/login           # Claim a worktree for a branch
many create worker-2                # Create new worktree named worker-2
many release                        # Release current worktree
many release feature/login          # Release worktree with that branch
many archive feature/login          # Archive worktree for that branch
many archive --force                # Archive current worktree, skip merge check

# Non-interactive usage (for scripts/automation)
many switch feature/login --no-interactive --worktree worker-1 --clean
many release feature/login --no-interactive --stash
```

### Pool Concept

Worktrees can be **claimed** (assigned to a branch) or **available** (on a temporary branch, ready to be claimed). The `release` command returns a worktree to the pool by switching it to a `tmp-<name>` branch. The original branch is preserved in git and can be reclaimed later with `many switch <branch>`.

## Web UI

Start with `many web`. The web UI provides:

- Repository management (add repos, configure main branch, init commands)
- Visual worktree list with claim/release status
- Create, switch, merge, rebase, and archive worktrees
- Open worktrees in your editor, terminal, or file manager
- Per-repo configuration (main branch, init command, worktree directory)

## Development

### Setup

```bash
git clone https://github.com/jsdf/many.git
cd many
npm install
```

### Scripts

```bash
npm run dev          # Build frontend + start web server
npm start            # Full build (frontend + CLI) + start web server
npm run build        # Type-check and build the React frontend with Vite
npm run build:cli    # Build the server and CLI with TypeScript
npm run cli          # Build and run the CLI
npm run test         # Run tests with Vitest
```

### Installing from Source

```bash
npm run build:cli && npm link
```

This builds the CLI and symlinks the `many` binary so it's available globally.

### Architecture

The project has two build pipelines:

- **Vite** builds the React frontend to `out/renderer/`
- **TypeScript** (`tsc -p tsconfig.cli.json`) builds the server and CLI to `dist-cli/`

The web server (`dist-cli/web/server.js`) serves the built frontend and provides a tRPC API. The CLI (`dist-cli/cli/index.js`) provides the command-line interface and also starts the web server via `many web`.

## License

MIT - see [LICENSE](LICENSE) for details.
