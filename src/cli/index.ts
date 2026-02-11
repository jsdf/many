#!/usr/bin/env node
// Many CLI - Git worktree pool manager

import { loadAppData, getRepoConfig, RepositoryConfig } from "./config.js";
import {
  getWorktrees,
  getAvailableWorktrees,
  getClaimedWorktrees,
  findWorktree,
  getWorktreeStatus,
  claimWorktree,
  releaseWorktree,
  stashChanges,
  cleanChanges,
  amendChanges,
  commitChanges,
  createWorktree,
  runInitCommand,
  getLocalBranchName,
  WorktreeInfo,
  GitStatus,
} from "./git-pool.js";
import { simpleGit } from "simple-git";
import * as readline from "readline";
import path from "path";
import { createRequire } from "node:module";

// Parsed flags for non-interactive use
interface ParsedFlags {
  noInteractive: boolean;
  worktree: string | null;     // --worktree <name> : select which worktree
  clean: boolean;              // --clean : discard uncommitted changes
  failIfDirty: boolean;        // --fail-if-dirty : exit 1 if uncommitted changes
  stash: boolean;              // --stash : stash uncommitted changes on release
  commitMessage: string | null; // --commit "msg" : commit changes on release
  amend: boolean;              // --amend : amend last commit on release
}

function parseFlags(args: string[]): { positional: string[]; flags: ParsedFlags } {
  const positional: string[] = [];
  const flags: ParsedFlags = {
    noInteractive: false,
    worktree: null,
    clean: false,
    failIfDirty: false,
    stash: false,
    commitMessage: null,
    amend: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--no-interactive":
      case "--ni":
        flags.noInteractive = true;
        break;
      case "--worktree":
      case "-w":
        flags.worktree = args[++i] ?? null;
        if (!flags.worktree) {
          console.error(red("Error: --worktree requires a value"));
          process.exit(1);
        }
        break;
      case "--clean":
        flags.clean = true;
        break;
      case "--fail-if-dirty":
        flags.failIfDirty = true;
        break;
      case "--stash":
        flags.stash = true;
        break;
      case "--commit":
        flags.commitMessage = args[++i] ?? null;
        if (!flags.commitMessage) {
          console.error(red("Error: --commit requires a message"));
          process.exit(1);
        }
        break;
      case "--amend":
        flags.amend = true;
        break;
      default:
        positional.push(arg);
        break;
    }
    i++;
  }

  return { positional, flags };
}

// Exit with an error in non-interactive mode, explaining which flags are needed
function exitNonInteractive(message: string, suggestedFlags: string[]): never {
  console.error(red(`Error (non-interactive): ${message}`));
  console.error(`\nProvide one of these flags to resolve this non-interactively:`);
  for (const flag of suggestedFlags) {
    console.error(`  ${flag}`);
  }
  process.exit(1);
}

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function bold(text: string): string {
  return `${colors.bold}${text}${colors.reset}`;
}

function dim(text: string): string {
  return `${colors.dim}${text}${colors.reset}`;
}

function green(text: string): string {
  return `${colors.green}${text}${colors.reset}`;
}

function yellow(text: string): string {
  return `${colors.yellow}${text}${colors.reset}`;
}

function red(text: string): string {
  return `${colors.red}${text}${colors.reset}`;
}

function cyan(text: string): string {
  return `${colors.cyan}${text}${colors.reset}`;
}

// Prompt user for input
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Find repository from current directory
async function findRepoFromCwd(): Promise<string | null> {
  try {
    const git = simpleGit(process.cwd());
    const root = await git.revparse(["--show-toplevel"]);
    return root.trim();
  } catch {
    return null;
  }
}

// Find repo config - checks if we're in a worktree and gets the main repo
async function getRepoAndConfig(): Promise<{
  repoPath: string;
  config: RepositoryConfig;
  currentWorktree: WorktreeInfo | null;
}> {
  const cwd = process.cwd();
  const appData = await loadAppData();

  // Check if current directory is a git repo
  const repoPath = await findRepoFromCwd();
  if (!repoPath) {
    throw new Error("Not in a git repository");
  }

  // Check if this repo (or its parent) is in our managed repos
  let managedRepoPath: string | null = null;

  // First check if the current repo is directly managed
  if (appData.repositories.some((r) => r.path === repoPath)) {
    managedRepoPath = repoPath;
  } else {
    // Check if we're in a worktree of a managed repo
    for (const repo of appData.repositories) {
      try {
        const worktrees = await getWorktrees(repo.path);
        const inWorktree = worktrees.find(
          (w) => w.path === repoPath || repoPath.startsWith(w.path + path.sep)
        );
        if (inWorktree) {
          managedRepoPath = repo.path;
          break;
        }
      } catch {
        // Ignore repos that fail
      }
    }
  }

  if (!managedRepoPath) {
    // Use current repo as-is, with default config
    return {
      repoPath,
      config: { mainBranch: null, initCommand: null, worktreeDirectory: null },
      currentWorktree: null,
    };
  }

  const config = getRepoConfig(appData, managedRepoPath);

  // Find current worktree if we're in one
  const worktrees = await getWorktrees(managedRepoPath);
  const currentWorktree = worktrees.find(
    (w) => w.path === cwd || cwd.startsWith(w.path + path.sep)
  ) || null;

  return { repoPath: managedRepoPath, config, currentWorktree };
}

// Format status for display
function formatStatus(status: GitStatus): string {
  const parts: string[] = [];
  if (status.staged.length > 0) {
    parts.push(green(`${status.staged.length} staged`));
  }
  if (status.modified.length > 0) {
    parts.push(yellow(`${status.modified.length} modified`));
  }
  if (status.not_added.length > 0) {
    parts.push(red(`${status.not_added.length} untracked`));
  }
  if (status.deleted.length > 0) {
    parts.push(red(`${status.deleted.length} deleted`));
  }
  if (status.created.length > 0) {
    parts.push(green(`${status.created.length} added`));
  }
  return parts.length > 0 ? parts.join(", ") : green("clean");
}

// List command - show all worktrees and their status
async function cmdList(): Promise<void> {
  const { repoPath, config } = await getRepoAndConfig();
  const worktrees = await getWorktrees(repoPath);

  console.log(bold(`\nWorktrees for ${path.basename(repoPath)}:\n`));

  // Separate into available and claimed
  const available = worktrees.filter((w) => w.isAvailable && !w.bare);
  const claimed = worktrees.filter((w) => !w.isAvailable && !w.bare);
  const base = worktrees.find((w) => w.path === repoPath);

  if (base) {
    const status = await getWorktreeStatus(base.path);
    console.log(
      `  ${cyan("●")} ${bold("base")} ${dim(`(${getLocalBranchName(base.branch)})`)} - ${formatStatus(status)}`
    );
    console.log(`    ${dim(base.path)}`);
    console.log();
  }

  if (claimed.length > 0) {
    console.log(bold("Claimed:"));
    for (const w of claimed) {
      if (w.path === repoPath) continue; // Skip base
      const status = await getWorktreeStatus(w.path);
      console.log(
        `  ${green("●")} ${bold(w.worktreeName)} ${dim(`(${getLocalBranchName(w.branch)})`)} - ${formatStatus(status)}`
      );
      console.log(`    ${dim(w.path)}`);
    }
    console.log();
  }

  if (available.length > 0) {
    console.log(bold("Available:"));
    for (const w of available) {
      const status = await getWorktreeStatus(w.path);
      console.log(
        `  ${yellow("○")} ${bold(w.worktreeName)} ${dim(`(${getLocalBranchName(w.branch)})`)} - ${formatStatus(status)}`
      );
      console.log(`    ${dim(w.path)}`);
    }
    console.log();
  }

  console.log(dim(`Total: ${worktrees.length - 1} worktrees (${claimed.length - (base ? 1 : 0)} claimed, ${available.length} available)`));
}

// Switch command - claim a worktree for a branch
async function cmdSwitch(branchName: string, flags: ParsedFlags): Promise<void> {
  const { repoPath, config, currentWorktree } = await getRepoAndConfig();

  // First check if a worktree is already on this branch
  const existingWorktree = await findWorktree(repoPath, branchName);
  if (existingWorktree && !existingWorktree.isAvailable) {
    console.log(
      yellow(`Branch '${branchName}' is already checked out in worktree: ${existingWorktree.path}`)
    );
    console.log(`\nTo work on it, cd to: ${existingWorktree.path}`);
    return;
  }

  // Get available worktrees
  const available = await getAvailableWorktrees(repoPath);

  if (available.length === 0) {
    console.log(red("No available worktrees in the pool."));
    console.log(`Use '${bold("many create <name>")}' to create a new worktree.`);
    process.exit(1);
  }

  // Let user pick a worktree if multiple available
  let targetWorktree: WorktreeInfo;

  if (flags.worktree) {
    // Select worktree by name via flag
    const match = available.find((w) => w.worktreeName === flags.worktree);
    if (!match) {
      console.log(red(`Worktree '${flags.worktree}' not found or not available.`));
      console.log("Available worktrees:");
      available.forEach((w) => console.log(`  ${w.worktreeName}`));
      process.exit(1);
    }
    targetWorktree = match;
  } else if (available.length === 1) {
    targetWorktree = available[0];
    console.log(`Using worktree: ${targetWorktree.worktreeName}`);
  } else if (flags.noInteractive) {
    exitNonInteractive(
      `Multiple worktrees available: ${available.map((w) => w.worktreeName).join(", ")}`,
      available.map((w) => `--worktree ${w.worktreeName}`),
    );
  } else {
    console.log("\nAvailable worktrees:");
    available.forEach((w, i) => {
      console.log(`  ${i + 1}. ${w.worktreeName} (${w.path})`);
    });

    const choice = await prompt("\nSelect worktree (number): ");
    const index = parseInt(choice, 10) - 1;

    if (isNaN(index) || index < 0 || index >= available.length) {
      console.log(red("Invalid selection"));
      return;
    }

    targetWorktree = available[index];
  }

  // Check for dirty state
  const status = await getWorktreeStatus(targetWorktree.path);
  if (status.hasChanges || status.hasStaged) {
    if (flags.failIfDirty) {
      console.error(red(`Worktree '${targetWorktree.worktreeName}' has uncommitted changes.`));
      console.error(`  ${formatStatus(status)}`);
      process.exit(1);
    } else if (flags.clean) {
      console.log("Cleaning uncommitted changes...");
      await cleanChanges(targetWorktree.path);
      console.log(green("Changes discarded."));
    } else if (flags.noInteractive) {
      exitNonInteractive(
        `Worktree '${targetWorktree.worktreeName}' has uncommitted changes: ${formatStatus(status)}`,
        [
          "--clean           Discard all uncommitted changes",
          "--fail-if-dirty   Exit with error instead",
        ],
      );
    } else {
      console.log(yellow("\nWorktree has uncommitted changes:"));
      console.log(`  ${formatStatus(status)}`);
      console.log("\nThese changes will be lost when switching branches.");
      const confirm = await prompt("Continue? (y/n): ");
      if (confirm.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
      // Clean the worktree
      await cleanChanges(targetWorktree.path);
    }
  }

  // Claim the worktree
  console.log(`\nSwitching ${targetWorktree.worktreeName} to branch '${branchName}'...`);
  await claimWorktree(repoPath, targetWorktree, branchName, config);

  console.log(green(`\nWorktree claimed for branch '${branchName}'`));
  console.log(`\nTo start working:\n  cd ${targetWorktree.path}`);
}

// Create command - create a new worktree
async function cmdCreate(worktreeName: string): Promise<void> {
  const { repoPath, config } = await getRepoAndConfig();

  // Check if worktree already exists
  const existing = await findWorktree(repoPath, worktreeName);
  if (existing) {
    console.log(red(`Worktree '${worktreeName}' already exists at: ${existing.path}`));
    return;
  }

  console.log(`Creating worktree '${worktreeName}'...`);

  const result = await createWorktree(repoPath, worktreeName, config);

  console.log(green(`\nWorktree created at: ${result.path}`));
  console.log(`Branch: ${result.branch}`);

  // Run init command if configured
  if (config.initCommand) {
    console.log(`\nRunning init command...`);
    try {
      await runInitCommand(result.path, config.initCommand);
      console.log(green("Init command completed successfully."));
    } catch (error) {
      console.log(yellow(`Init command failed: ${error}`));
    }
  }

  console.log(`\nTo start working:\n  cd ${result.path}`);
}

// Release command - release a worktree back to the pool
async function cmdRelease(identifier: string | undefined, flags: ParsedFlags): Promise<void> {
  const { repoPath, config, currentWorktree } = await getRepoAndConfig();

  // Determine which worktree to release
  let targetWorktree: WorktreeInfo | null = null;

  if (identifier) {
    targetWorktree = await findWorktree(repoPath, identifier);
    if (!targetWorktree) {
      console.log(red(`Worktree or branch '${identifier}' not found.`));
      process.exit(1);
    }
  } else if (flags.worktree) {
    targetWorktree = await findWorktree(repoPath, flags.worktree);
    if (!targetWorktree) {
      console.log(red(`Worktree '${flags.worktree}' not found.`));
      process.exit(1);
    }
  } else if (currentWorktree) {
    targetWorktree = currentWorktree;
  } else if (flags.noInteractive) {
    const claimed = await getClaimedWorktrees(repoPath);
    const nonBase = claimed.filter((w) => w.path !== repoPath);
    if (nonBase.length === 0) {
      console.log(yellow("No claimed worktrees to release."));
      process.exit(1);
    }
    exitNonInteractive(
      "Not in a worktree and no identifier provided. Claimed worktrees: " +
        nonBase.map((w) => `${w.worktreeName} (${getLocalBranchName(w.branch)})`).join(", "),
      [
        "many release <branch-name>     Specify the branch to release",
        "--worktree <name>              Specify the worktree by name",
      ],
    );
  } else {
    // List claimed worktrees and let user pick
    const claimed = await getClaimedWorktrees(repoPath);
    const nonBase = claimed.filter((w) => w.path !== repoPath);

    if (nonBase.length === 0) {
      console.log(yellow("No claimed worktrees to release."));
      return;
    }

    console.log("\nClaimed worktrees:");
    nonBase.forEach((w, i) => {
      console.log(`  ${i + 1}. ${w.worktreeName} (${getLocalBranchName(w.branch)})`);
    });

    const choice = await prompt("\nSelect worktree to release (number): ");
    const index = parseInt(choice, 10) - 1;

    if (isNaN(index) || index < 0 || index >= nonBase.length) {
      console.log(red("Invalid selection"));
      return;
    }

    targetWorktree = nonBase[index];
  }

  // Don't allow releasing the base repo
  if (targetWorktree.path === repoPath) {
    console.log(red("Cannot release the base repository worktree."));
    process.exit(1);
  }

  // Check if already available
  if (targetWorktree.isAvailable) {
    console.log(yellow(`Worktree '${targetWorktree.worktreeName}' is already available (not claimed).`));
    return;
  }

  const currentBranch = getLocalBranchName(targetWorktree.branch);
  console.log(`\nReleasing worktree: ${targetWorktree.worktreeName}`);
  console.log(`Current branch: ${currentBranch}`);

  // Check for changes
  const status = await getWorktreeStatus(targetWorktree.path);

  if (status.hasChanges || status.hasStaged) {
    // Determine dirty handling from flags
    const dirtyFlagCount = [flags.stash, flags.commitMessage !== null, flags.amend, flags.clean, flags.failIfDirty]
      .filter(Boolean).length;

    if (dirtyFlagCount > 1) {
      console.error(red("Error: Only one of --stash, --commit, --amend, --clean, --fail-if-dirty can be used."));
      process.exit(1);
    }

    if (flags.failIfDirty) {
      console.error(red(`Worktree '${targetWorktree.worktreeName}' has uncommitted changes.`));
      console.error(`  ${formatStatus(status)}`);
      process.exit(1);
    } else if (flags.stash) {
      console.log("Stashing changes...");
      await stashChanges(targetWorktree.path, `Release stash from ${currentBranch}`);
      console.log(green("Changes stashed."));
    } else if (flags.commitMessage !== null) {
      console.log("Committing changes...");
      await commitChanges(targetWorktree.path, flags.commitMessage);
      console.log(green("Changes committed."));
    } else if (flags.amend) {
      console.log("Amending last commit...");
      await amendChanges(targetWorktree.path);
      console.log(green("Changes amended to last commit."));
    } else if (flags.clean) {
      console.log("Cleaning uncommitted changes...");
      await cleanChanges(targetWorktree.path);
      console.log(green("Changes discarded."));
    } else if (flags.noInteractive) {
      exitNonInteractive(
        `Worktree '${targetWorktree.worktreeName}' has uncommitted changes: ${formatStatus(status)}`,
        [
          '--stash              Stash changes for later',
          '--commit "message"   Commit changes with the given message',
          '--amend              Amend changes to the last commit',
          '--clean              Discard all uncommitted changes',
          '--fail-if-dirty      Exit with error instead',
        ],
      );
    } else {
      console.log(yellow("\nWorktree has uncommitted changes:"));

      if (status.staged.length > 0) {
        console.log(`  Staged: ${status.staged.join(", ")}`);
      }
      if (status.modified.length > 0) {
        console.log(`  Modified: ${status.modified.join(", ")}`);
      }
      if (status.not_added.length > 0) {
        console.log(`  Untracked: ${status.not_added.join(", ")}`);
      }
      if (status.deleted.length > 0) {
        console.log(`  Deleted: ${status.deleted.join(", ")}`);
      }

      console.log("\nHow would you like to handle these changes?");
      console.log("  1. Stash - Save changes to stash for later");
      console.log("  2. Commit - Create a new commit with these changes");
      console.log("  3. Amend - Add changes to the last commit");
      console.log("  4. Clean - Discard all changes");
      console.log("  5. Cancel - Abort release");

      const choice = await prompt("\nSelect option (1-5): ");

      switch (choice) {
        case "1":
          console.log("Stashing changes...");
          await stashChanges(targetWorktree.path, `Release stash from ${currentBranch}`);
          console.log(green("Changes stashed."));
          break;

        case "2":
          const message = await prompt("Commit message: ");
          if (!message) {
            console.log(red("Commit message required."));
            return;
          }
          console.log("Committing changes...");
          await commitChanges(targetWorktree.path, message);
          console.log(green("Changes committed."));
          break;

        case "3":
          console.log("Amending last commit...");
          await amendChanges(targetWorktree.path);
          console.log(green("Changes amended to last commit."));
          break;

        case "4":
          const confirmClean = await prompt(
            yellow("This will PERMANENTLY DELETE all uncommitted changes. Are you sure? (yes/no): ")
          );
          if (confirmClean.toLowerCase() !== "yes") {
            console.log("Aborted.");
            return;
          }
          console.log("Cleaning changes...");
          await cleanChanges(targetWorktree.path);
          console.log(green("Changes discarded."));
          break;

        case "5":
        default:
          console.log("Aborted.");
          return;
      }
    }
  }

  // Release the worktree
  console.log("\nReleasing worktree to pool...");
  const tmpBranch = await releaseWorktree(repoPath, targetWorktree, config);

  console.log(green(`\nWorktree released.`));
  console.log(`Now on temporary branch: ${tmpBranch}`);
  console.log(`\nThe branch '${currentBranch}' still exists and can be reclaimed with:`);
  console.log(`  many switch ${currentBranch}`);
}

// Help command
function showHelp(): void {
  console.log(`
${bold("Many CLI")} - Git worktree pool manager

${bold("USAGE:")}
  many <command> [args] [flags]

${bold("COMMANDS:")}
  ${bold("version")}                 Show the CLI version
  ${bold("list")}                    List all worktrees and their status
  ${bold("switch")} <branch>         Claim a worktree and checkout the branch
                          Creates branch from default if it doesn't exist
  ${bold("create")} <name>           Create a new worktree with the given name
                          Runs configured init command if any
  ${bold("release")} [branch|name]   Release a worktree back to the pool
                          Handles uncommitted changes interactively

${bold("FLAGS:")}
  ${bold("--no-interactive")}        Exit with error if a prompt would be shown,
                          with a message explaining which flags to provide
  ${bold("--worktree")} <name>       Select which worktree to use (switch/release)
  ${bold("--clean")}                 Discard uncommitted changes (switch/release)
  ${bold("--fail-if-dirty")}         Exit with error if uncommitted changes exist
  ${bold("--stash")}                 Stash uncommitted changes (release)
  ${bold("--commit")} "message"      Commit uncommitted changes (release)
  ${bold("--amend")}                 Amend uncommitted changes to last commit (release)

${bold("EXAMPLES:")}
  many list                    # Show all worktrees
  many switch feature/login    # Claim a worktree for feature/login branch
  many create worker-2         # Create new worktree named worker-2
  many release                 # Release current worktree
  many release feature/login   # Release worktree with that branch

  ${dim("# Non-interactive usage (for scripts/automation):")}
  many switch feature/login --no-interactive --worktree worker-1 --clean
  many release feature/login --no-interactive --stash

${bold("POOL CONCEPT:")}
  Worktrees can be "claimed" (assigned to a branch) or "available" (on a
  temporary branch, ready to be claimed). Release returns a worktree to
  the pool by switching it to a tmp-<name> branch.

${bold("WEB UI:")}
  many web                     # Start the web UI on http://localhost:3000
  many web --port 8080         # Use a custom port
  many web --open              # Open browser automatically
`);
}

// Web command - start the web server
async function cmdWeb(args: string[]): Promise<void> {
  let port = 3000;
  let open = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" || args[i] === "-p") {
      port = parseInt(args[i + 1], 10);
      if (isNaN(port)) {
        console.log(red("Error: Invalid port number"));
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--open" || args[i] === "-o") {
      open = true;
    }
  }

  console.log(bold("\nStarting Many Web Server..."));

  // Dynamic import to avoid loading web server dependencies for other commands
  const { startWebServer } = await import("../web/server.js");
  await startWebServer({ port, open });
}

function getVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../../package.json");
  return pkg.version;
}

// Main entry point
async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseFlags(rawArgs);
  const command = positional[0];

  try {
    switch (command) {
      case "version":
      case "-v":
      case "--version":
        console.log(getVersion());
        break;

      case "list":
      case "ls":
      case undefined:
        await cmdList();
        break;

      case "switch":
      case "sw":
        if (!positional[1]) {
          console.log(red("Error: Branch name required"));
          console.log("Usage: many switch <branch-name>");
          process.exit(1);
        }
        await cmdSwitch(positional[1], flags);
        break;

      case "create":
      case "new":
        if (!positional[1]) {
          console.log(red("Error: Worktree name required"));
          console.log("Usage: many create <worktree-name>");
          process.exit(1);
        }
        await cmdCreate(positional[1]);
        break;

      case "release":
      case "rel":
        await cmdRelease(positional[1], flags);
        break;

      case "web":
        await cmdWeb(rawArgs.slice(1));
        break;

      case "help":
      case "-h":
      case "--help":
        showHelp();
        break;

      default:
        console.log(red(`Unknown command: ${command}`));
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error(red(`Error: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}

main();
