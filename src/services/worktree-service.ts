// WorktreeService - business logic for worktree pool management
// Consumed by both the web server (tRPC/SSE handlers) and the CLI.
// Config is passed in — callers load from disk; this service stays pure and testable.

import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import logger from "../shared/logger.js";
import * as gitPool from "../cli/git-pool.js";
import type { WorktreeInfo } from "../cli/git-pool.js";
import type { RepositoryConfig, PoolConfig } from "../cli/config.js";

// Re-export pool primitives so server only needs one import
export {
  getWorktrees,
  getAvailableWorktrees,
  getClaimedWorktrees,
  findWorktree,
  getWorktreeStatus,
  getDefaultBranch as getDefaultBranchForConfig,
  createWorktree,
  stashChanges,
  cleanChanges,
  amendChanges,
  commitChanges,
  isTmpBranch,
  getLocalBranchName,
  type WorktreeInfo,
} from "../cli/git-pool.js";
import {
  checkBranchMerged,
  removeWorktree,
  parseWorktreeList,
  readWorktreeListFromFS,
  isTmpBranch as isTmpBranchCore,
  extractWorktreeName,
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

/**
 * Lightweight worktree list read directly from the filesystem (no git process).
 * Returns the same WorktreeInfo shape as getWorktrees() but much cheaper.
 */
export async function getWorktreesFromFS(
  repoPath: string
): Promise<WorktreeInfo[]> {
  const parsed = await readWorktreeListFromFS(repoPath);
  return parsed.map((w) => ({
    path: w.path,
    commit: w.commit || "",
    branch: w.branch || null,
    bare: w.bare || false,
    isAvailable: isTmpBranchCore(w.branch),
    worktreeName: extractWorktreeName(w.path, repoPath),
  }));
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

  let prNumber: string | undefined;
  const prNumberMatch = sp.match(/^#?(\d+)$/);
  if (prNumberMatch) {
    prNumber = prNumberMatch[1];
  } else {
    try {
      const url = new URL(sp);
      const segments = url.pathname.split("/").filter(Boolean);
      if (
        url.hostname === "github.com" &&
        segments.length >= 4 &&
        segments[2] === "pull"
      ) {
        // github.com/<owner>/<repo>/pull/<number>
        const num = segments[3];
        if (/^\d+$/.test(num)) prNumber = num;
      } else if (
        /^(?:app\.)?graphite\.(?:dev|com)$/.test(url.hostname) &&
        segments[0] === "github" &&
        segments.length >= 4 &&
        segments[3] === "pull" &&
        segments.length >= 5
      ) {
        // app.graphite.com/github/<owner>/<repo>/pull/<number>
        const num = segments[4];
        if (/^\d+$/.test(num)) prNumber = num;
      }
    } catch {
      // Not a URL — treat as branch name below
    }
  }

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
  existingWorktreePath?: string;
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

  if (options.existingWorktreePath) {
    // Use an existing worktree directly — skip claim/create
    targetWorktreePath = options.existingWorktreePath;
    onProgress?.({ type: "step", text: `Using existing worktree: ${targetWorktreePath}` });

    // Determine current branch
    const realPath = await fs.realpath(targetWorktreePath).catch(() => targetWorktreePath);
    const worktrees = await gitPool.getWorktrees(repoPath);
    const wt = worktrees.find((w) => w.path === realPath);
    if (!wt) {
      const msg = `Worktree not found at path: ${targetWorktreePath}`;
      onProgress?.({ type: "error", text: msg });
      throw new Error(msg);
    }
    taskBranch = wt.branch?.replace(/^refs\/heads\//, "") ?? "unknown";
  } else if (options.poolType === "recyclable") {
    // Step 2a: Find an available worktree in the pool
    onProgress?.({ type: "step", text: `Finding available worktree in pool "${options.poolPrefix}"...` });
    const worktrees = await gitPool.getWorktrees(repoPath);
    const candidates = worktrees.filter(
      (w): w is WorktreeInfo =>
        w.path !== repoPath &&
        !w.bare &&
        (w.branch?.replace(/^refs\/heads\//, "") || "").startsWith("tmp-") &&
        w.worktreeName.startsWith(options.poolPrefix)
    );
    if (candidates.length === 0) {
      const msg = `No available worktrees in pool with prefix "${options.poolPrefix}".`;
      onProgress?.({ type: "error", text: msg });
      throw new Error(msg);
    }

    // Prefer a clean worktree; fall back to a dirty one (cleaning it first)
    let available: WorktreeInfo | undefined;
    let needsClean = false;
    for (const candidate of candidates) {
      const status = await gitPool.getWorktreeStatus(candidate.path);
      if (!status.hasChanges && !status.hasStaged) {
        available = candidate;
        break;
      }
    }
    if (!available) {
      available = candidates[0];
      needsClean = true;
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

    if (needsClean) {
      onProgress?.({ type: "step", text: `Worktree has leftover changes, cleaning before claim...` });
      await gitPool.cleanChanges(available.path);
    }

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

// --- claimWorktreeByPath / releaseWorktreeByPath ---
// Path-based variants used by the server (client sends worktreePath, not WorktreeInfo).

export async function claimWorktreeByPath(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  mainBranch: string | null,
  pullLatest = true
): Promise<void> {
  const realPath = await fs.realpath(worktreePath).catch(() => worktreePath);
  const worktrees = await gitPool.getWorktrees(repoPath);
  const worktree = worktrees.find((w) => w.path === realPath);
  if (!worktree) throw new Error(`Worktree not found: ${worktreePath}`);
  await gitPool.claimWorktree(repoPath, worktree, branchName, { mainBranch, initCommand: null, worktreeDirectory: null }, pullLatest);
}

export async function releaseWorktreeByPath(
  repoPath: string,
  worktreePath: string,
  mainBranch: string | null,
  force = false
): Promise<string> {
  const realPath = await fs.realpath(worktreePath).catch(() => worktreePath);
  const worktrees = await gitPool.getWorktrees(repoPath);
  const worktree = worktrees.find((w) => w.path === realPath);
  if (!worktree) throw new Error(`Worktree not found: ${worktreePath}`);
  return gitPool.releaseWorktree(repoPath, worktree, { mainBranch, initCommand: null, worktreeDirectory: null }, force);
}

// --- getBranches ---

export async function getBranches(repoPath: string): Promise<string[]> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(repoPath);
  const branches = await git.branch(["--all"]);
  return branches.all
    .filter((b) => !b.startsWith("remotes/"))
    .map((b) => b.replace("*", "").trim())
    .filter((b) => b.length > 0);
}

// --- getGitUsername ---

export async function getGitUsername(repoPath: string): Promise<string> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(repoPath);
  const config = await git.listConfig();
  return (config.all["user.name"] as string) || "user";
}

// --- checkBranchMergedByName ---
// Public-facing version that resolves the default branch and returns structured result.

export async function checkBranchMergedByName(
  repoPath: string,
  branchName: string,
  mainBranch: string | null
): Promise<{ isFullyMerged: boolean; mainBranch: string; branchName: string }> {
  const { simpleGit } = await import("simple-git");
  const resolvedMain = await gitPool.getDefaultBranch(repoPath, { mainBranch, initCommand: null, worktreeDirectory: null });
  const git = simpleGit(repoPath);
  const mergeBase = (await git.raw(["merge-base", branchName, resolvedMain])).trim();
  const branchCommit = (await git.raw(["rev-parse", branchName])).trim();
  return { isFullyMerged: mergeBase === branchCommit, mainBranch: resolvedMain, branchName };
}

// --- mergeWorktree ---

export interface MergeOptions {
  squash?: boolean;
  noFF?: boolean;
  message?: string;
}

export async function mergeWorktree(
  repoPath: string,
  fromBranch: string,
  toBranch: string,
  options: MergeOptions = {}
): Promise<void> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(repoPath);
  await git.checkout(toBranch);
  const mergeArgs = ["merge"];
  if (options.squash) mergeArgs.push("--squash");
  if (options.noFF) mergeArgs.push("--no-ff");
  if (options.message) mergeArgs.push("-m", options.message);
  mergeArgs.push(fromBranch);
  await git.raw(mergeArgs);
  if (options.squash) {
    await git.commit(options.message || `Merge ${fromBranch} (squashed)`);
  }
}

// --- rebaseWorktree ---

export async function rebaseWorktree(
  worktreePath: string,
  fromBranch: string,
  ontoBranch: string
): Promise<void> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(worktreePath);
  await git.checkout(fromBranch);
  await git.raw(["rebase", ontoBranch]);
}

// --- getCommitLog ---

export async function getCommitLog(worktreePath: string, baseBranch: string): Promise<string> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(worktreePath);
  const output = await git.raw(["log", `${baseBranch}^..HEAD`, "--pretty=format:%s"]);
  return output.trim();
}

// --- getBranchDiff ---

export async function getBranchDiff(
  worktreePath: string,
  repoPath: string,
  mainBranch: string | null
): Promise<{ diff: string; mainBranch: string }> {
  const { simpleGit } = await import("simple-git");
  const git = simpleGit(worktreePath);
  const resolvedMain = await gitPool.getDefaultBranch(repoPath, { mainBranch, initCommand: null, worktreeDirectory: null });

  // Detect if we're on the main branch itself. If so, only show uncommitted
  // working tree changes (diff against HEAD), not committed history.
  const currentBranch = (await git.raw(["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim();
  const onMainBranch = currentBranch === resolvedMain;

  let diffBase: string;
  if (onMainBranch) {
    diffBase = "HEAD";
  } else {
    try {
      diffBase = (await git.raw(["merge-base", resolvedMain, "HEAD"])).trim();
    } catch {
      return { diff: "", mainBranch: resolvedMain };
    }
  }

  // Diff from the base to working tree. On feature branches this combines
  // committed branch changes and uncommitted modifications. On main this
  // only shows uncommitted modifications.
  const trackedDiff = await git.raw(["diff", diffBase]);

  // Include untracked files (new files not yet staged) so they appear in the
  // branch changes view alongside everything else.
  let untrackedDiff = "";
  try {
    const untrackedOutput = await git.raw([
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const untrackedFiles = untrackedOutput
      .trim()
      .split("\n")
      .filter(Boolean);
    if (untrackedFiles.length > 0) {
      // Generate diffs for untracked files by diffing against empty tree
      const untrackedPatches: string[] = [];
      for (const file of untrackedFiles) {
        try {
          const patch = await git.raw([
            "diff",
            "--no-index",
            "/dev/null",
            file,
          ]);
          untrackedPatches.push(patch);
        } catch (err: unknown) {
          // git diff --no-index exits with code 1 when files differ (which is
          // always the case here). simple-git throws on non-zero exit, but the
          // stderr/stdout still contains the patch. Extract it from the error.
          if (err && typeof err === "object" && "stdout" in err) {
            const stdout = (err as { stdout: string }).stdout;
            if (stdout) untrackedPatches.push(stdout);
          }
        }
      }
      untrackedDiff = untrackedPatches.filter(Boolean).join("\n");
    }
  } catch {
    // If listing untracked files fails, just skip them
  }

  const diff = [trackedDiff, untrackedDiff].filter(Boolean).join("\n");
  return { diff, mainBranch: resolvedMain };
}

// --- getGitHubLink ---

export type GitHubLinkResult =
  | { type: "pr"; url: string }
  | { type: "branch"; url: string }
  | null;

export async function getGitHubLink(repoPath: string, branch: string): Promise<GitHubLinkResult> {
  const normalizedBranch = branch.replace(/^refs\/heads\//, "");

  const getGitHubRepoUrl = async (): Promise<string | null> => {
    try {
      const { simpleGit } = await import("simple-git");
      const git = simpleGit(repoPath);
      const remoteUrl = (await git.remote(["get-url", "origin"])) as string;
      const trimmed = remoteUrl.trim();
      const sshMatch = trimmed.match(/git@github\.com:(.+?)(?:\.git)?$/);
      if (sshMatch) return `https://github.com/${sshMatch[1]}`;
      const httpsMatch = trimmed.match(/(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) return httpsMatch[1];
    } catch {}
    return null;
  };

  try {
    const { stdout, stderr } = await execAsync(
      `gh pr view ${JSON.stringify(normalizedBranch)} --json url --jq .url`,
      { cwd: repoPath }
    );
    const url = stdout.trim();
    if (url) return { type: "pr", url };
    if (stderr.trim()) logger.debug(`[getGitHubLink] gh pr view stderr: ${stderr.trim()}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no pull requests found")) {
      logger.debug(`[getGitHubLink] gh pr view failed for branch=${normalizedBranch} cwd=${repoPath}: ${msg}`);
    }
  }

  try {
    const { stdout } = await execAsync(
      `gh browse -n --branch ${JSON.stringify(normalizedBranch)}`,
      { cwd: repoPath }
    );
    const url = stdout.trim();
    if (url) return { type: "branch", url };
  } catch {}

  const repoUrl = await getGitHubRepoUrl();
  if (repoUrl) return { type: "branch", url: `${repoUrl}/tree/${normalizedBranch}` };
  return null;
}

// --- getLinearLink (via mux work items DB) ---

export type LinearLinkResult = { linearId: string; linearUrl: string } | null;

async function getGitHubRepo(repoPath: string): Promise<string | null> {
  try {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit(repoPath);
    const remoteUrl = (await git.remote(["get-url", "origin"])) as string;
    const trimmed = remoteUrl.trim();
    const match = trimmed.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

let _muxDb: Database.Database | null = null;
function getMuxDb(): Database.Database | null {
  if (_muxDb) return _muxDb;
  const dbPath = path.join(homedir(), ".claude", "mux-cache.db");
  try {
    _muxDb = new Database(dbPath, { readonly: true, timeout: 5_000 });
    _muxDb.pragma("journal_mode = WAL");
    return _muxDb;
  } catch {
    return null;
  }
}

export async function getLinearLink(repoPath: string, branch: string): Promise<LinearLinkResult> {
  const normalizedBranch = branch.replace(/^refs\/heads\//, "");
  const repo = await getGitHubRepo(repoPath);
  if (!repo) return null;
  const db = getMuxDb();
  if (!db) return null;
  try {
    const row = db.prepare<[string, string], { linearId: string; linearUrl: string }>(
      "SELECT linear_id as linearId, linear_url as linearUrl FROM work_items WHERE repo = ? AND branch = ?"
    ).get(repo, normalizedBranch);
    if (row && (row.linearUrl || row.linearId)) {
      return { linearId: row.linearId, linearUrl: row.linearUrl };
    }
  } catch (err) {
    logger.debug(`[getLinearLink] mux db query failed: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}

/**
 * Assign the PR for a branch to the current `gh` user (@me).
 * Returns true if a PR was found and assigned, false otherwise.
 * Silently swallows errors (no gh, no PR, already assigned, etc).
 */
export async function assignPrToMe(repoPath: string, branch: string): Promise<boolean> {
  const normalizedBranch = branch.replace(/^refs\/heads\//, "");
  try {
    await execAsync(
      `gh pr edit ${JSON.stringify(normalizedBranch)} --add-assignee @me`,
      { cwd: repoPath }
    );
    logger.info(`[assignPrToMe] assigned PR for branch=${normalizedBranch} to @me`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[assignPrToMe] failed for branch=${normalizedBranch}: ${msg}`);
    return false;
  }
}
