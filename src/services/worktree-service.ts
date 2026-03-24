// WorktreeService - business logic for worktree pool management
// Consumed by both the web server (tRPC/SSE handlers) and the CLI.
// Config is passed in — callers load from disk; this service stays pure and testable.

import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as gitPool from "../cli/git-pool.js";
import type { WorktreeInfo } from "../cli/git-pool.js";
import type { RepositoryConfig, PoolConfig } from "../cli/config.js";
import {
  checkBranchMerged,
  removeWorktree,
  parseWorktreeList,
  getErrorMessage,
} from "../shared/git-core.js";
import { registerTask, type TaskRecord } from "../cli/task-registry.js";
import type { OnProgress, RunCommand } from "./types.js";

const _exec = promisify(exec);
const userShell = process.env.SHELL || "/bin/bash";

function execAsync(command: string, options?: Record<string, unknown>) {
  const loginCommand = `${userShell} -l -c ${JSON.stringify(command)}`;
  return _exec(loginCommand, { ...options });
}

// --- resolveStartingPoint ---

/**
 * Resolve a user-provided starting point (branch name, PR number, or PR URL)
 * to a branch name, fetching it from the remote.
 */
export async function resolveStartingPoint(
  repoPath: string,
  startingPoint: string,
  onProgress?: OnProgress
): Promise<string> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(repoPath);
  const sp = startingPoint.trim();

  let branchName: string;

  const ghUrlMatch = sp.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  const graphiteUrlMatch = sp.match(/graphite\.dev\/github\/pr\/[^/]+\/[^/]+\/(\d+)/);
  const prNumberMatch = sp.match(/^#?(\d+)$/);
  const prNumber = ghUrlMatch?.[1] || graphiteUrlMatch?.[1] || prNumberMatch?.[1];

  if (prNumber) {
    const { stdout } = await execAsync(
      `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
      { cwd: repoPath }
    );
    branchName = stdout.trim();
    if (!branchName) throw new Error(`Could not resolve PR #${prNumber}`);
  } else {
    branchName = sp;
  }

  try {
    await git.fetch("origin", branchName);
  } catch {
    const branches = await git.branch();
    if (
      !branches.all.includes(branchName) &&
      !branches.all.includes(`remotes/origin/${branchName}`)
    ) {
      throw new Error(`Branch "${branchName}" not found locally or on remote`);
    }
    onProgress?.({ type: "step", text: `Branch not on remote, using local branch` });
  }

  onProgress?.({ type: "step", text: `Resolved to branch: ${branchName}` });
  return branchName;
}

// --- archiveWorktree ---

/**
 * Remove a worktree directory and clean up git references.
 * If force is false and mainBranch is provided, checks the branch is merged first.
 */
export async function archiveWorktree(
  repoPath: string,
  worktreePath: string,
  options: { force?: boolean; mainBranch?: string | null } = {}
): Promise<void> {
  if (!options.force && options.mainBranch !== undefined) {
    const realWorktreePath = await fs.realpath(worktreePath).catch(() => worktreePath);
    const worktrees = await parseWorktreeList(repoPath);
    const current = worktrees.find((w) => w.path === realWorktreePath);

    if (current?.branch) {
      try {
        const result = await checkBranchMerged(
          repoPath,
          current.branch,
          options.mainBranch ?? null
        );
        if (!result.isFullyMerged) {
          throw new Error(
            `UNMERGED_BRANCH:Branch '${current.branch}' is not fully merged into '${result.mainBranch}'.`
          );
        }
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        if (msg.includes("UNMERGED_BRANCH:")) throw err;
        throw new Error(
          `MERGE_CHECK_FAILED:Could not determine if branch '${current.branch}' is merged into '${options.mainBranch}'.`
        );
      }
    }
  }

  await removeWorktree(repoPath, worktreePath);
}

// --- createAndSetupWorktree ---

export interface CreateAndSetupOptions {
  worktreeName: string;
  startingPoint?: string;
  poolPrefix?: string;
  pullLatest?: boolean;
  initCommand?: string | null;
  mainBranch: string | null;
  worktreeDirectory: string | null;
}

export interface CreateAndSetupResult {
  worktreePath: string;
  branch: string;
}

/**
 * Compound workflow: create a worktree, optionally resolve a starting point,
 * claim it for a branch, and run an init command.
 */
export async function createAndSetupWorktree(
  repoPath: string,
  options: CreateAndSetupOptions,
  onProgress?: OnProgress,
  runCommand?: RunCommand
): Promise<CreateAndSetupResult> {
  const config: RepositoryConfig = {
    mainBranch: options.mainBranch,
    initCommand: options.initCommand ?? null,
    worktreeDirectory: options.worktreeDirectory,
  };

  // Step 1: Resolve starting point
  let resolvedBranch: string | undefined;
  if (options.startingPoint) {
    onProgress?.({ type: "step", text: `Resolving starting point: ${options.startingPoint}` });
    try {
      resolvedBranch = await resolveStartingPoint(repoPath, options.startingPoint, onProgress);
    } catch (err: any) {
      onProgress?.({ type: "error", text: `Failed to resolve starting point: ${err.message}` });
      throw err;
    }
  }

  // Step 2: Determine worktree name
  const worktreeName = options.poolPrefix
    ? `${options.poolPrefix}-${options.worktreeName}`
    : options.worktreeName;

  // Step 3: Create the worktree
  onProgress?.({ type: "step", text: `Creating worktree: ${worktreeName}` });
  let result: { path: string; branch: string };
  try {
    result = await gitPool.createWorktree(repoPath, worktreeName, config);
    onProgress?.({ type: "step", text: `Worktree created at ${result.path}` });
  } catch (err: any) {
    onProgress?.({ type: "error", text: `Failed to create worktree: ${err.message}` });
    throw err;
  }

  // Step 4: Claim for the resolved branch if we have one
  const pullLatest = options.pullLatest !== false;
  if (resolvedBranch) {
    onProgress?.({
      type: "step",
      text: `Checking out branch: ${resolvedBranch}${pullLatest ? " (pulling latest)" : ""}`,
    });
    try {
      const realResultPath = await fs.realpath(result.path).catch(() => result.path);
      const worktrees = await gitPool.getWorktrees(repoPath);
      const wt = worktrees.find((w) => w.path === realResultPath);
      if (wt) {
        await gitPool.claimWorktree(repoPath, wt, resolvedBranch, config, pullLatest);
      }
      onProgress?.({ type: "step", text: "Branch checked out" });
    } catch (err: any) {
      onProgress?.({ type: "error", text: `Failed to checkout branch: ${err.message}` });
      throw err;
    }
  }

  // Step 5: Run init command if configured
  if (options.initCommand && runCommand) {
    onProgress?.({ type: "step", text: `Running init command: ${options.initCommand}` });
    const code = await runCommand(options.initCommand, result.path, onProgress);
    if (code !== 0) {
      onProgress?.({ type: "step", text: `Init command exited with code ${code} (continuing anyway)` });
    } else {
      onProgress?.({ type: "step", text: "Init command completed" });
    }
  }

  return {
    worktreePath: result.path,
    branch: resolvedBranch ?? result.branch,
  };
}

// --- launchTask ---

export interface LaunchTaskOptions {
  poolType: "recyclable" | "ephemeral";
  poolPrefix: string;
  prompt: string;
  startingPoint?: string;
  maintenanceCommand?: string;
  initCommand?: string | null;
  mainBranch: string | null;
  worktreeDirectory: string | null;
  taskCommand?: string;
  launchedBy: "cli" | "web";
  logFile?: string;
}

export interface LaunchTaskResult {
  worktreePath: string;
  branch: string;
  taskRecord: TaskRecord;
}

/**
 * Compound workflow: acquire a worktree (from pool or create ephemeral),
 * optionally resolve a starting point, run maintenance/init, and register a task.
 *
 * Does NOT spawn the task process — the caller handles that (server and CLI
 * have different spawning strategies).
 */
export async function launchTask(
  repoPath: string,
  options: LaunchTaskOptions,
  onProgress?: OnProgress,
  runCommand?: RunCommand
): Promise<LaunchTaskResult> {
  const config: RepositoryConfig = {
    mainBranch: options.mainBranch,
    initCommand: options.initCommand ?? null,
    worktreeDirectory: options.worktreeDirectory,
  };

  // Step 1: Resolve starting point
  let resolvedBranch: string | undefined;
  if (options.startingPoint) {
    onProgress?.({ type: "step", text: `Resolving starting point: ${options.startingPoint}` });
    try {
      resolvedBranch = await resolveStartingPoint(repoPath, options.startingPoint, onProgress);
    } catch (err: any) {
      onProgress?.({ type: "error", text: `Failed to resolve starting point: ${err.message}` });
      throw err;
    }
  }

  let targetWorktreePath: string;
  let taskBranch: string;

  if (options.poolType === "recyclable") {
    // Step 2a: Find an available worktree in the pool
    onProgress?.({ type: "step", text: `Finding available worktree in pool "${options.poolPrefix}"...` });
    const worktrees = await gitPool.getWorktrees(repoPath);
    const available = worktrees.find(
      (w): w is WorktreeInfo =>
        w.path !== repoPath &&
        !w.bare &&
        (w.branch?.replace(/^refs\/heads\//, "") || "").startsWith("tmp-") &&
        w.worktreeName.startsWith(options.poolPrefix)
    );
    if (!available) {
      const msg = `No available worktrees in pool with prefix "${options.poolPrefix}".`;
      onProgress?.({ type: "error", text: msg });
      throw new Error(msg);
    }
    onProgress?.({ type: "step", text: `Using worktree: ${available.worktreeName}` });

    // Step 2b: Claim the worktree
    taskBranch =
      resolvedBranch ??
      `task/${options.prompt
        .slice(0, 40)
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()}-${Date.now().toString(36)}`;

    onProgress?.({ type: "step", text: `Claiming worktree → branch: ${taskBranch}` });
    try {
      await gitPool.claimWorktree(repoPath, available, taskBranch, config);
      onProgress?.({ type: "step", text: "Worktree claimed successfully" });
    } catch (err: any) {
      onProgress?.({ type: "error", text: `Failed to claim worktree: ${err.message}` });
      throw err;
    }

    // Step 2c: Run maintenance command
    if (options.maintenanceCommand && runCommand) {
      onProgress?.({ type: "step", text: `Running maintenance command: ${options.maintenanceCommand}` });
      const code = await runCommand(options.maintenanceCommand, available.path, onProgress);
      if (code !== 0) {
        onProgress?.({ type: "step", text: `Maintenance command exited with code ${code} (continuing anyway)` });
      } else {
        onProgress?.({ type: "step", text: "Maintenance command completed" });
      }
    }

    targetWorktreePath = available.path;
  } else {
    // Ephemeral: create a new worktree
    const name = `${options.poolPrefix}-${Date.now().toString(36)}`;
    onProgress?.({ type: "step", text: `Creating worktree: ${name}` });
    let result: { path: string; branch: string };
    try {
      result = await gitPool.createWorktree(repoPath, name, config);
      targetWorktreePath = result.path;
      onProgress?.({ type: "step", text: `Worktree created at ${result.path}` });
    } catch (err: any) {
      onProgress?.({ type: "error", text: `Failed to create worktree: ${err.message}` });
      throw err;
    }

    // Check out starting branch if provided
    if (resolvedBranch) {
      onProgress?.({ type: "step", text: `Checking out branch: ${resolvedBranch}` });
      try {
        const realTargetPath = await fs.realpath(targetWorktreePath).catch(() => targetWorktreePath);
        const worktrees = await gitPool.getWorktrees(repoPath);
        const wt = worktrees.find((w) => w.path === realTargetPath);
        if (wt) {
          await gitPool.claimWorktree(repoPath, wt, resolvedBranch, config);
        }
        onProgress?.({ type: "step", text: "Branch checked out" });
      } catch (err: any) {
        onProgress?.({ type: "error", text: `Failed to checkout branch: ${err.message}` });
        throw err;
      }
    }

    taskBranch = resolvedBranch ?? result.branch;

    // Run init command
    if (options.initCommand && runCommand) {
      onProgress?.({ type: "step", text: `Running init command: ${options.initCommand}` });
      const code = await runCommand(options.initCommand, targetWorktreePath, onProgress);
      if (code !== 0) {
        onProgress?.({ type: "step", text: `Init command exited with code ${code} (continuing anyway)` });
      } else {
        onProgress?.({ type: "step", text: "Init command completed" });
      }
    }
  }

  // Register the task record (pid 0 — caller updates after spawning)
  const taskRecord = await registerTask({
    pid: 0,
    repoPath,
    worktreePath: targetWorktreePath,
    poolPrefix: options.poolPrefix,
    poolName: options.poolPrefix,
    branch: taskBranch,
    prompt: options.prompt,
    taskCommand: options.taskCommand ?? "",
    launchedBy: options.launchedBy,
    ...(options.logFile ? { logFile: options.logFile } : {}),
  });

  return { worktreePath: targetWorktreePath, branch: taskBranch, taskRecord };
}
