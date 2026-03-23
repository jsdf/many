// Web server for Many - serves the frontend and tRPC API over HTTP
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import type { AddressInfo } from "net";
import { initTRPC } from "@trpc/server";
import { nodeHTTPRequestHandler } from "@trpc/server/adapters/node-http";
import { WebSocketServer, WebSocket } from "ws";
import * as gitPool from "../cli/git-pool.js";
import { loadAppData, saveAppData, getRepoConfig, getGlobalSettings, getDataPath } from "../cli/config.js";
import {
  registerTask,
  markTaskCompleted,
  updateTaskPid,
  reconcileTasks,
  listTasks as listTaskRecords,
  killTask as killTaskById,
  TaskRecord,
} from "../cli/task-registry.js";
import {
  checkBranchMerged,
  removeWorktree,
  getErrorMessage,
  parseWorktreeList,
} from "../shared/git-core.js";
import { TerminalManager } from "./terminal-manager.js";
import { getClaudeSessions, getSessionMessages } from "./claude-sessions.js";
import { RepoWatcher } from "./git-watcher.js";

const _execAsync = promisify(exec);
const userShell = process.env.SHELL || "/bin/bash";
// Run commands in a login shell so PATH includes tools like gh, node, etc.
function execAsync(command: string, options?: Record<string, unknown>) {
  // Wrap command to run in a login shell, ensuring PATH is fully configured
  const loginCommand = `${userShell} -l -c ${JSON.stringify(command)}`;
  return _execAsync(loginCommand, { ...options });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Create tRPC instance
const t = initTRPC.create();

// Terminal manager - singleton, lives for the server's lifetime
const terminalManager = new TerminalManager();

// External actions - open apps using child_process
async function openInFileManager(folderPath: string): Promise<boolean> {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [folderPath], { detached: true, stdio: "ignore" });
  } else if (platform === "win32") {
    spawn("explorer", [folderPath], { detached: true, stdio: "ignore" });
  } else {
    spawn("xdg-open", [folderPath], { detached: true, stdio: "ignore" });
  }
  return true;
}

async function openInEditor(folderPath: string, editor?: string | null): Promise<boolean> {
  if (editor) {
    spawn(editor, [folderPath], { detached: true, stdio: "ignore" });
    return true;
  }
  const editors = ["code", "cursor", "subl", "atom"];
  for (const ed of editors) {
    try {
      spawn(ed, [folderPath], { detached: true, stdio: "ignore" });
      return true;
    } catch {
      continue;
    }
  }
  // Fallback to file manager
  return openInFileManager(folderPath);
}

async function openInTerminal(folderPath: string, terminal?: string | null): Promise<boolean> {
  const platform = process.platform;
  if (terminal) {
    if (platform === "darwin") {
      spawn("open", ["-a", terminal, folderPath], { detached: true, stdio: "ignore" });
    } else {
      spawn(terminal, [], { cwd: folderPath, detached: true, stdio: "ignore" });
    }
    return true;
  }
  if (platform === "darwin") {
    spawn("open", ["-a", "Terminal", folderPath], { detached: true, stdio: "ignore" });
  } else if (platform === "win32") {
    spawn("cmd", ["/c", "start", "cmd", "/k", `cd /d "${folderPath}"`], { detached: true, stdio: "ignore" });
  } else {
    const terminals = ["gnome-terminal", "konsole", "xterm"];
    for (const term of terminals) {
      try {
        if (term === "gnome-terminal") {
          spawn(term, ["--working-directory", folderPath], { detached: true, stdio: "ignore" });
        } else {
          spawn(term, ["-e", "bash"], { cwd: folderPath, detached: true, stdio: "ignore" });
        }
        break;
      } catch {
        continue;
      }
    }
  }
  return true;
}

async function openVSCode(dirPath: string): Promise<boolean> {
  await execAsync(`code "${dirPath}"`);
  return true;
}

// Create the router
const createRouter = () => {
  return t.router({
    // Git operations
    getWorktrees: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        return await gitPool.getWorktrees(input.repoPath);
      }),

    getBranches: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        const branches = await git.branch(["--all"]);
        return branches.all
          .filter((branch) => !branch.startsWith("remotes/"))
          .map((branch) => branch.replace("*", "").trim())
          .filter((branch) => branch.length > 0);
      }),

    getGitUsername: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        const config = await git.listConfig();
        return config.all["user.name"] || "user";
      }),

    createWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; branchName: string; baseBranch: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const result = await gitPool.createWorktree(input.repoPath, input.branchName, repoConfig);
        return { ...result, initCommand: repoConfig.initCommand };
      }),

    archiveWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; force?: boolean })
      .mutation(async ({ input }) => {
        if (!input.force) {
          // Check if branch is merged before archiving
          const worktrees = await parseWorktreeList(input.repoPath);
          const currentWorktree = worktrees.find((w) => w.path === input.worktreePath);

          if (currentWorktree && currentWorktree.branch) {
            const appData = await loadAppData();
            const repoConfig = getRepoConfig(appData, input.repoPath);

            if (repoConfig.mainBranch) {
              try {
                const result = await checkBranchMerged(
                  input.repoPath,
                  currentWorktree.branch,
                  repoConfig.mainBranch
                );

                if (!result.isFullyMerged) {
                  throw new Error(
                    `UNMERGED_BRANCH:Branch '${currentWorktree.branch}' is not fully merged into '${repoConfig.mainBranch}'.`
                  );
                }
              } catch (mergeCheckError: unknown) {
                const errorMsg = getErrorMessage(mergeCheckError);
                if (errorMsg.includes("UNMERGED_BRANCH:")) {
                  throw mergeCheckError;
                }
                throw new Error(
                  `MERGE_CHECK_FAILED:Could not determine if branch '${currentWorktree.branch}' is merged into '${repoConfig.mainBranch}'.`
                );
              }
            }
          }
        }

        // Kill any terminal sessions for this worktree
        terminalManager.cleanupWorktree(input.worktreePath);

        await removeWorktree(input.repoPath, input.worktreePath);
        return true;
      }),

    checkBranchMerged: t.procedure
      .input((input: unknown) => input as { repoPath: string; branchName: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const mainBranch = await gitPool.getDefaultBranch(input.repoPath, repoConfig);
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        const mergeBase = await git.raw(["merge-base", input.branchName, mainBranch]);
        const branchCommit = await git.raw(["rev-parse", input.branchName]);
        return {
          isFullyMerged: mergeBase.trim() === branchCommit.trim(),
          mainBranch,
          branchName: input.branchName,
        };
      }),

    mergeWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; fromBranch: string; toBranch: string; options: any })
      .mutation(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        await git.checkout(input.toBranch);
        const mergeArgs = ["merge"];
        if (input.options?.squash) mergeArgs.push("--squash");
        if (input.options?.noFF) mergeArgs.push("--no-ff");
        if (input.options?.message) mergeArgs.push("-m", input.options.message);
        mergeArgs.push(input.fromBranch);
        await git.raw(mergeArgs);
        if (input.options?.squash) {
          const commitMessage = input.options?.message || `Merge ${input.fromBranch} (squashed)`;
          await git.commit(commitMessage);
        }
        return true;
      }),

    rebaseWorktree: t.procedure
      .input((input: unknown) => input as { worktreePath: string; fromBranch: string; ontoBranch: string })
      .mutation(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.worktreePath);
        await git.checkout(input.fromBranch);
        await git.raw(["rebase", input.ontoBranch]);
        return true;
      }),

    getWorktreeStatus: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .query(async ({ input }) => {
        return await gitPool.getWorktreeStatus(input.worktreePath);
      }),

    getCommitLog: t.procedure
      .input((input: unknown) => input as { worktreePath: string; baseBranch: string })
      .query(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.worktreePath);
        const logOutput = await git.raw(["log", `${input.baseBranch}^..HEAD`, "--pretty=format:%s"]);
        return logOutput.trim();
      }),

    // Repository management
    getSavedRepos: t.procedure.query(async () => {
      const appData = await loadAppData();
      return appData.repositories;
    }),

    saveRepo: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const exists = appData.repositories.some((repo: any) => repo.path === input.repoPath);
        if (!exists) {
          const repoName = path.basename(input.repoPath);
          appData.repositories.push({
            path: input.repoPath,
            name: repoName,
            addedAt: new Date().toISOString(),
          });
          await saveAppData(appData);
        }
        return true;
      }),

    getSelectedRepo: t.procedure.query(async () => {
      const appData = await loadAppData();
      return appData.selectedRepo;
    }),

    setSelectedRepo: t.procedure
      .input((input: unknown) => input as { repoPath: string | null })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        appData.selectedRepo = input.repoPath;
        await saveAppData(appData);
        return true;
      }),

    getRepoConfig: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        return getRepoConfig(appData, input.repoPath);
      }),

    saveRepoConfig: t.procedure
      .input((input: unknown) => input as { repoPath: string; config: any })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        appData.repositoryConfigs[input.repoPath] = input.config;
        await saveAppData(appData);
        return true;
      }),

    getRecentWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        return appData.recentWorktrees[input.repoPath] || null;
      }),

    setRecentWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        appData.recentWorktrees[input.repoPath] = input.worktreePath;
        await saveAppData(appData);
        return true;
      }),

    selectFolder: t.procedure.mutation(async () => {
      // Not supported in web version - user must type the path
      return null;
    }),

    // Global settings
    getGlobalSettings: t.procedure.query(async () => {
      const appData = await loadAppData();
      return getGlobalSettings(appData);
    }),

    saveGlobalSettings: t.procedure
      .input((input: unknown) => input as { defaultEditor: string | null; defaultTerminal: string | null })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        appData.globalSettings = {
          defaultEditor: input.defaultEditor,
          defaultTerminal: input.defaultTerminal,
        };
        await saveAppData(appData);
        return true;
      }),

    // External actions
    openInFileManager: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async ({ input }) => openInFileManager(input.folderPath)),

    openInEditor: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const settings = getGlobalSettings(appData);
        return openInEditor(input.folderPath, settings.defaultEditor);
      }),

    openInTerminal: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const settings = getGlobalSettings(appData);
        return openInTerminal(input.folderPath, settings.defaultTerminal);
      }),

    openDirectory: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async ({ input }) => openInFileManager(input.dirPath)),

    openTerminalInDirectory: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const settings = getGlobalSettings(appData);
        return openInTerminal(input.dirPath, settings.defaultTerminal);
      }),

    openVSCode: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async ({ input }) => openVSCode(input.dirPath)),

    // GitHub integration
    getGitHubLink: t.procedure
      .input((input: unknown) => input as { repoPath: string; branch: string })
      .query(async ({ input }) => {
        const branch = input.branch.replace(/^refs\/heads\//, "");

        // Helper: get GitHub repo URL from git remote
        const getGitHubRepoUrl = async (): Promise<string | null> => {
          try {
            const { simpleGit } = await import("simple-git");
            const git = simpleGit(input.repoPath);
            const remoteUrl = (await git.remote(["get-url", "origin"])) as string;
            const trimmed = remoteUrl.trim();
            // Convert git@github.com:owner/repo.git or https://github.com/owner/repo.git to https://github.com/owner/repo
            const sshMatch = trimmed.match(/git@github\.com:(.+?)(?:\.git)?$/);
            if (sshMatch) return `https://github.com/${sshMatch[1]}`;
            const httpsMatch = trimmed.match(/(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/);
            if (httpsMatch) return httpsMatch[1];
          } catch {
            // not a git repo or no remote
          }
          return null;
        };

        // Try to get PR URL for this branch
        try {
          const { stdout, stderr } = await execAsync(
            `gh pr view ${JSON.stringify(branch)} --json url --jq .url`,
            { cwd: input.repoPath }
          );
          const url = stdout.trim();
          if (url) return { type: "pr" as const, url };
          if (stderr.trim()) console.log(`[getGitHubLink] gh pr view stderr: ${stderr.trim()}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[getGitHubLink] gh pr view failed for branch=${branch} cwd=${input.repoPath}: ${msg}`);
        }
        // Fall back to branch URL on GitHub
        try {
          const { stdout } = await execAsync(
            `gh browse -n --branch ${JSON.stringify(branch)}`,
            { cwd: input.repoPath }
          );
          const url = stdout.trim();
          if (url) return { type: "branch" as const, url };
        } catch {
          // gh not available, fall through to git remote fallback
        }
        // Final fallback: construct URL from git remote
        const repoUrl = await getGitHubRepoUrl();
        if (repoUrl) {
          return { type: "branch" as const, url: `${repoUrl}/tree/${branch}` };
        }
        return null;
      }),

    // Pool management operations
    isTmpBranch: t.procedure
      .input((input: unknown) => input as { branchName: string | null })
      .query(({ input }) => {
        return input.branchName?.replace(/^refs\/heads\//, "").startsWith("tmp-") || false;
      }),

    getDefaultBranch: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        return await gitPool.getDefaultBranch(input.repoPath, repoConfig);
      }),

    claimWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; branchName: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const worktrees = await gitPool.getWorktrees(input.repoPath);
        const worktree = worktrees.find(w => w.path === input.worktreePath);
        if (!worktree) {
          throw new Error(`Worktree not found: ${input.worktreePath}`);
        }
        await gitPool.claimWorktree(input.repoPath, worktree, input.branchName, repoConfig);
        return { success: true };
      }),

    releaseWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; force?: boolean })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const worktrees = await gitPool.getWorktrees(input.repoPath);
        const worktree = worktrees.find(w => w.path === input.worktreePath);
        if (!worktree) {
          throw new Error(`Worktree not found: ${input.worktreePath}`);
        }
        // Kill any terminal sessions for this worktree
        terminalManager.cleanupWorktree(input.worktreePath);

        const newBranch = await gitPool.releaseWorktree(input.repoPath, worktree, repoConfig, input.force ?? false);
        return { success: true, branch: newBranch };
      }),

    stashWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string; message?: string })
      .mutation(async ({ input }) => {
        await gitPool.stashChanges(input.worktreePath, input.message);
        return true;
      }),

    cleanWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .mutation(async ({ input }) => {
        await gitPool.cleanChanges(input.worktreePath);
        return true;
      }),

    amendWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .mutation(async ({ input }) => {
        await gitPool.amendChanges(input.worktreePath);
        return true;
      }),

    commitWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string; message: string })
      .mutation(async ({ input }) => {
        await gitPool.commitChanges(input.worktreePath, input.message);
        return true;
      }),

    runMaintenanceCommand: t.procedure
      .input((input: unknown) => input as { worktreePath: string; command: string })
      .mutation(async ({ input }) => {
        const { execSync } = await import("child_process");
        try {
          execSync(input.command, {
            cwd: input.worktreePath,
            stdio: "pipe",
            timeout: 120000,
          });
          return { success: true };
        } catch (err: any) {
          throw new Error(`Maintenance command failed: ${err.message}`);
        }
      }),

    getBranchDiff: t.procedure
      .input((input: unknown) => input as { worktreePath: string; repoPath: string })
      .query(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.worktreePath);
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const mainBranch = await gitPool.getDefaultBranch(input.repoPath, repoConfig);

        // Find the merge-base between HEAD and the main branch
        let mergeBase: string;
        try {
          mergeBase = (await git.raw(["merge-base", mainBranch, "HEAD"])).trim();
        } catch {
          // If merge-base fails (e.g. no common ancestor), return empty
          return { diff: "", mainBranch };
        }

        // Get committed changes: merge-base..HEAD
        const committedDiff = await git.raw(["diff", `${mergeBase}...HEAD`]);

        // Get uncommitted changes (staged + unstaged) against HEAD
        const uncommittedDiff = await git.raw(["diff", "HEAD"]);

        // Combine both diffs
        const combinedDiff = [committedDiff, uncommittedDiff].filter(Boolean).join("\n");

        return { diff: combinedDiff, mainBranch };
      }),

    createPoolWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreeName: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const result = await gitPool.createWorktree(input.repoPath, input.worktreeName, repoConfig);
        return { ...result, initCommand: repoConfig.initCommand };
      }),

    // Terminal management
    getTerminalSessions: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .query(({ input }) => {
        return terminalManager.getSessionsForWorktree(input.worktreePath);
      }),

    closeTerminal: t.procedure
      .input((input: unknown) => input as { terminalId: string })
      .mutation(({ input }) => {
        terminalManager.closeSession(input.terminalId);
        return true;
      }),

    // Resolve a starting point (branch name, PR number, PR URL) to a branch name and fetch it
    resolveStartingPoint: t.procedure
      .input((input: unknown) => input as { repoPath: string; startingPoint: string })
      .mutation(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        const sp = input.startingPoint.trim();

        let branchName: string;

        // Try to parse as GitHub PR URL: https://github.com/owner/repo/pull/123
        const ghUrlMatch = sp.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        // Try to parse as Graphite PR URL: https://app.graphite.dev/github/pr/owner/repo/123
        const graphiteUrlMatch = sp.match(/graphite\.dev\/github\/pr\/[^/]+\/[^/]+\/(\d+)/);
        // Try to parse as plain PR number
        const prNumberMatch = sp.match(/^#?(\d+)$/);

        const prNumber = ghUrlMatch?.[1] || graphiteUrlMatch?.[1] || prNumberMatch?.[1];

        if (prNumber) {
          // Resolve PR number to branch name using gh CLI
          try {
            const { stdout } = await execAsync(
              `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
              { cwd: input.repoPath }
            );
            branchName = stdout.trim();
            if (!branchName) {
              throw new Error(`Could not resolve PR #${prNumber} to a branch name`);
            }
          } catch (err: any) {
            throw new Error(`Failed to resolve PR #${prNumber}: ${err.message}`);
          }
        } else {
          // Treat as a branch name directly
          branchName = sp;
        }

        // Fetch the branch from origin, fall back to local
        try {
          await git.fetch("origin", branchName);
        } catch {
          const branches = await git.branch();
          if (!branches.all.includes(branchName) && !branches.all.includes(`remotes/origin/${branchName}`)) {
            throw new Error(`Branch "${branchName}" not found locally or on remote`);
          }
        }

        return { branchName };
      }),

    // Task registry endpoints
    listTasks: t.procedure
      .input((v: unknown) => v as { repoPath?: string; status?: string })
      .query(async ({ input }) => {
        await reconcileTasks();
        const filter: { repoPath?: string; status?: any } = {};
        if (input && typeof input === "object") {
          if ((input as any).repoPath) filter.repoPath = (input as any).repoPath;
          if ((input as any).status) filter.status = (input as any).status;
        }
        return listTaskRecords(filter);
      }),

    killTaskById: t.procedure
      .input((v: unknown) => v as { taskId: string })
      .mutation(async ({ input }) => {
        const killed = await killTaskById((input as any).taskId);
        return { success: killed };
      }),

    getTaskLog: t.procedure
      .input((v: unknown) => v as { taskId: string; offset?: number })
      .query(async ({ input }) => {
        const { getTask } = await import("../cli/task-registry.js");
        const task = await getTask((input as any).taskId);
        if (!task?.logFile) return { content: "", size: 0 };
        try {
          const stat = await fs.stat(task.logFile);
          const offset = (input as any).offset || 0;
          // Read from offset, cap at 100KB per request
          const maxRead = 100 * 1024;
          const start = Math.max(offset, 0);
          const fh = await fs.open(task.logFile, "r");
          const buf = Buffer.alloc(Math.min(maxRead, stat.size - start));
          if (buf.length > 0) {
            await fh.read(buf, 0, buf.length, start);
          }
          await fh.close();
          return { content: buf.toString("utf-8"), size: stat.size };
        } catch {
          return { content: "", size: 0 };
        }
      }),

    // Claude session discovery
    getClaudeSessions: t.procedure
      .input((v: unknown) => v as { worktreePath: string })
      .query(async ({ input }) => {
        return getClaudeSessions((input as any).worktreePath);
      }),

    getSessionMessages: t.procedure
      .input((v: unknown) => v as { sessionId: string; worktreePath: string; offset?: number; limit?: number })
      .query(async ({ input }) => {
        const { sessionId, worktreePath, offset, limit } = input as any;
        return getSessionMessages(sessionId, worktreePath, offset, limit);
      }),
  });
};

export type AppRouter = ReturnType<typeof createRouter>;

// Serve static file
async function serveStaticFile(filePath: string): Promise<{ status: number; body: Buffer | string; contentType: string }> {
  try {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = await fs.readFile(filePath);
    return { status: 200, body: content, contentType };
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { status: 404, body: "Not found", contentType: "text/plain" };
    }
    throw error;
  }
}

export interface WebServerOptions {
  port?: number;
  host?: string;
  open?: boolean;
  token?: string;
}

export interface WebServerResult {
  url: string;
  port: number;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerResult> {
  const port = options.port ?? 0;
  const host = options.host || "localhost";
  const token = options.token || crypto.randomBytes(24).toString("hex");

  const router = createRouter();

  // Reconcile task registry on startup
  await reconcileTasks();

  // Determine static files directory
  const distDir = path.join(PROJECT_ROOT, "out", "renderer");

  // Check if built files exist (optional in dev mode where Vite serves the frontend)
  let hasStaticFiles = false;
  try {
    await fs.access(path.join(distDir, "index.html"));
    hasStaticFiles = true;
  } catch {
    console.log("Note: Built frontend not found. Assuming dev mode (Vite serves frontend).");
  }

  function checkToken(req: http.IncomingMessage, url: URL): boolean {
    const headerToken = req.headers["x-token"];
    if (headerToken === token) return true;
    const queryToken = url.searchParams.get("token");
    if (queryToken === token) return true;
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-token");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      // tRPC API requires token
      if (pathname.startsWith("/trpc/")) {
        if (!checkToken(req, url)) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
        // Strip /trpc prefix - the adapter expects just the procedure path
        req.url = req.url!.replace(/^\/trpc/, "");
        await nodeHTTPRequestHandler({
          router,
          path: pathname.replace(/^\/trpc\//, ""),
          req,
          res,
          createContext: () => ({}),
        });
        return;
      }

      // SSE endpoint for running init commands with streaming output
      if (pathname === "/api/run-init" && req.method === "POST") {
        if (!checkToken(req, url)) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }

        // Read request body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        let parsed: { worktreePath: string; initCommand: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
          return;
        }

        if (!parsed.worktreePath || !parsed.initCommand) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing worktreePath or initCommand");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const child = spawn(parsed.initCommand, {
          shell: true,
          cwd: parsed.worktreePath,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const sendEvent = (data: object) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        child.stdout.on("data", (chunk: Buffer) => {
          sendEvent({ type: "stdout", text: chunk.toString() });
        });

        child.stderr.on("data", (chunk: Buffer) => {
          sendEvent({ type: "stderr", text: chunk.toString() });
        });

        child.on("error", (error) => {
          sendEvent({ type: "error", message: error.message });
          res.end();
        });

        child.on("close", (code) => {
          sendEvent({ type: "done", code: code ?? 1 });
          res.end();
        });

        // If client disconnects, kill the child process
        req.on("close", () => {
          if (!child.killed) {
            child.kill();
          }
        });

        return;
      }

      // SSE endpoint for creating worktrees with streaming progress
      if (pathname === "/api/create-worktree" && req.method === "POST") {
        if (!checkToken(req, url)) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }

        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        let parsed: {
          repoPath: string;
          worktreeName: string;
          startingPoint?: string;
          poolPrefix?: string;
          pullLatest?: boolean;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const sendEvent = (data: object) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const appData = await loadAppData();
          const repoConfig = getRepoConfig(appData, parsed.repoPath);

          // Step 1: Resolve starting point if provided
          let resolvedBranch: string | undefined;
          if (parsed.startingPoint) {
            sendEvent({ type: "step", text: `Resolving starting point: ${parsed.startingPoint}` });
            try {
              const { simpleGit } = await import("simple-git");
              const git = simpleGit(parsed.repoPath);
              const sp = parsed.startingPoint.trim();
              let branchName: string;

              const ghUrlMatch = sp.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
              const graphiteUrlMatch = sp.match(/graphite\.dev\/github\/pr\/[^/]+\/[^/]+\/(\d+)/);
              const prNumberMatch = sp.match(/^#?(\d+)$/);
              const prNumber = ghUrlMatch?.[1] || graphiteUrlMatch?.[1] || prNumberMatch?.[1];

              if (prNumber) {
                const { stdout } = await execAsync(
                  `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
                  { cwd: parsed.repoPath }
                );
                branchName = stdout.trim();
                if (!branchName) throw new Error(`Could not resolve PR #${prNumber}`);
              } else {
                branchName = sp;
              }

              // Fetch from remote, fall back to local branch
              try {
                await git.fetch("origin", branchName);
              } catch {
                const branches = await git.branch();
                if (!branches.all.includes(branchName) && !branches.all.includes(`remotes/origin/${branchName}`)) {
                  throw new Error(`Branch "${branchName}" not found locally or on remote`);
                }
                sendEvent({ type: "step", text: `Branch not on remote, using local branch` });
              }
              resolvedBranch = branchName;
              sendEvent({ type: "step", text: `Resolved to branch: ${branchName}` });
            } catch (err: any) {
              sendEvent({ type: "error", text: `Failed to resolve starting point: ${err.message}` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }
          }

          // Step 2: Determine worktree name
          const worktreeName = parsed.poolPrefix
            ? `${parsed.poolPrefix}-${parsed.worktreeName}`
            : parsed.worktreeName;

          // Step 3: Create the worktree
          sendEvent({ type: "step", text: `Creating worktree: ${worktreeName}` });
          let result: { path: string; branch: string };
          try {
            result = await gitPool.createWorktree(parsed.repoPath, worktreeName, repoConfig);
            sendEvent({ type: "step", text: `Worktree created at ${result.path}` });
          } catch (err: any) {
            sendEvent({ type: "error", text: `Failed to create worktree: ${err.message}` });
            sendEvent({ type: "done", success: false });
            res.end();
            return;
          }

          // Step 4: Claim for the resolved branch if we have one
          const pullLatest = parsed.pullLatest !== false; // default true
          if (resolvedBranch) {
            sendEvent({ type: "step", text: `Checking out branch: ${resolvedBranch}${pullLatest ? ' (pulling latest)' : ''}` });
            try {
              const worktrees = await gitPool.getWorktrees(parsed.repoPath);
              const wt = worktrees.find((w) => w.path === result.path);
              if (wt) {
                await gitPool.claimWorktree(parsed.repoPath, wt, resolvedBranch, repoConfig, pullLatest);
              }
              sendEvent({ type: "step", text: "Branch checked out" });
            } catch (err: any) {
              sendEvent({ type: "error", text: `Failed to checkout branch: ${err.message}` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }
          }

          // Step 5: Run init command if configured
          if (repoConfig.initCommand) {
            sendEvent({ type: "step", text: `Running init command: ${repoConfig.initCommand}` });
            const child = spawn(repoConfig.initCommand, {
              shell: userShell,
              cwd: result.path,
              stdio: ["ignore", "pipe", "pipe"],
            });

            await new Promise<void>((resolve) => {
              child.stdout.on("data", (chunk: Buffer) => {
                sendEvent({ type: "stdout", text: chunk.toString() });
              });
              child.stderr.on("data", (chunk: Buffer) => {
                sendEvent({ type: "stderr", text: chunk.toString() });
              });
              child.on("close", (code) => {
                if (code !== 0) {
                  sendEvent({ type: "step", text: `Init command exited with code ${code} (continuing anyway)` });
                } else {
                  sendEvent({ type: "step", text: "Init command completed" });
                }
                resolve();
              });
              child.on("error", (error) => {
                sendEvent({ type: "stderr", text: error.message });
                resolve();
              });
              req.on("close", () => {
                if (!child.killed) child.kill();
              });
            });
          }

          sendEvent({ type: "done", success: true, worktreePath: result.path, branch: resolvedBranch || result.branch });
        } catch (err: any) {
          sendEvent({ type: "error", text: `Unexpected error: ${err.message}` });
          sendEvent({ type: "done", success: false });
        }

        res.end();
        return;
      }

      // SSE endpoint for launching tasks with streaming progress
      if (pathname === "/api/launch-task" && req.method === "POST") {
        if (!checkToken(req, url)) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }

        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        let parsed: {
          repoPath: string;
          poolType: "recyclable" | "ephemeral";
          poolPrefix: string;
          prompt: string;
          startingPoint?: string;
          maintenanceCommand?: string;
          taskCommand?: string;
        };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const sendEvent = (data: object) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const runCommand = (command: string, cwd: string): Promise<number> => {
          return new Promise((resolve) => {
            const child = spawn(command, {
              shell: true,
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
            });

            child.stdout.on("data", (chunk: Buffer) => {
              sendEvent({ type: "stdout", text: chunk.toString() });
            });

            child.stderr.on("data", (chunk: Buffer) => {
              sendEvent({ type: "stderr", text: chunk.toString() });
            });

            child.on("error", (error) => {
              sendEvent({ type: "stderr", text: error.message });
              resolve(1);
            });

            child.on("close", (code) => {
              resolve(code ?? 1);
            });

            req.on("close", () => {
              if (!child.killed) child.kill();
            });
          });
        };

        try {
          const appData = await loadAppData();
          const repoConfig = getRepoConfig(appData, parsed.repoPath);

          // Step 1: Resolve starting point
          let resolvedBranch: string | undefined;
          if (parsed.startingPoint) {
            sendEvent({ type: "step", text: `Resolving starting point: ${parsed.startingPoint}` });
            try {
              const { simpleGit } = await import("simple-git");
              const git = simpleGit(parsed.repoPath);
              const sp = parsed.startingPoint.trim();
              let branchName: string;

              const ghUrlMatch = sp.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
              const graphiteUrlMatch = sp.match(/graphite\.dev\/github\/pr\/[^/]+\/[^/]+\/(\d+)/);
              const prNumberMatch = sp.match(/^#?(\d+)$/);
              const prNumber = ghUrlMatch?.[1] || graphiteUrlMatch?.[1] || prNumberMatch?.[1];

              if (prNumber) {
                const { stdout } = await execAsync(
                  `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
                  { cwd: parsed.repoPath }
                );
                branchName = stdout.trim();
                if (!branchName) throw new Error(`Could not resolve PR #${prNumber}`);
              } else {
                branchName = sp;
              }

              // Fetch from remote, fall back to local branch
              try {
                await git.fetch("origin", branchName);
              } catch {
                const branches = await git.branch();
                if (!branches.all.includes(branchName) && !branches.all.includes(`remotes/origin/${branchName}`)) {
                  throw new Error(`Branch "${branchName}" not found locally or on remote`);
                }
                sendEvent({ type: "step", text: `Branch not on remote, using local branch` });
              }
              resolvedBranch = branchName;
              sendEvent({ type: "step", text: `Resolved to branch: ${branchName}` });
            } catch (err: any) {
              sendEvent({ type: "error", text: `Failed to resolve starting point: ${err.message}` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }
          }

          let targetWorktreePath: string;

          if (parsed.poolType === "recyclable") {
            // Step 2: Find available worktree
            sendEvent({ type: "step", text: `Finding available worktree in pool "${parsed.poolPrefix}"...` });
            const worktrees = await gitPool.getWorktrees(parsed.repoPath);
            const available = worktrees.find(
              (w) =>
                w.path !== parsed.repoPath &&
                !w.bare &&
                (w.branch?.replace(/^refs\/heads\//, "") || "").startsWith("tmp-") &&
                w.worktreeName.startsWith(parsed.poolPrefix)
            );
            if (!available || !available.path) {
              sendEvent({ type: "error", text: `No available worktrees in pool with prefix "${parsed.poolPrefix}".` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }
            sendEvent({ type: "step", text: `Using worktree: ${available.worktreeName}` });

            // Step 3: Claim worktree
            const branchName =
              resolvedBranch ??
              `task/${parsed.prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}-${Date.now().toString(36)}`;
            sendEvent({ type: "step", text: `Claiming worktree → branch: ${branchName}` });
            try {
              await gitPool.claimWorktree(parsed.repoPath, available, branchName, repoConfig);
              sendEvent({ type: "step", text: "Worktree claimed successfully" });
            } catch (err: any) {
              sendEvent({ type: "error", text: `Failed to claim worktree: ${err.message}` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }

            // Step 4: Run maintenance command
            if (parsed.maintenanceCommand) {
              sendEvent({ type: "step", text: `Running maintenance command: ${parsed.maintenanceCommand}` });
              const code = await runCommand(parsed.maintenanceCommand, available.path);
              if (code !== 0) {
                sendEvent({ type: "step", text: `Maintenance command exited with code ${code} (continuing anyway)` });
              } else {
                sendEvent({ type: "step", text: "Maintenance command completed" });
              }
            }

            targetWorktreePath = available.path;
          } else {
            // Ephemeral: create new worktree
            const name = `${parsed.poolPrefix}-${Date.now().toString(36)}`;
            sendEvent({ type: "step", text: `Creating worktree: ${name}` });
            try {
              const result = await gitPool.createWorktree(parsed.repoPath, name, repoConfig);
              targetWorktreePath = result.path;
              sendEvent({ type: "step", text: `Worktree created at ${result.path}` });
            } catch (err: any) {
              sendEvent({ type: "error", text: `Failed to create worktree: ${err.message}` });
              sendEvent({ type: "done", success: false });
              res.end();
              return;
            }

            // Check out starting branch if provided
            if (resolvedBranch) {
              sendEvent({ type: "step", text: `Checking out branch: ${resolvedBranch}` });
              try {
                const worktrees = await gitPool.getWorktrees(parsed.repoPath);
                const wt = worktrees.find((w) => w.path === targetWorktreePath);
                if (wt) {
                  await gitPool.claimWorktree(parsed.repoPath, wt, resolvedBranch, repoConfig);
                }
                sendEvent({ type: "step", text: "Branch checked out" });
              } catch (err: any) {
                sendEvent({ type: "error", text: `Failed to checkout branch: ${err.message}` });
                sendEvent({ type: "done", success: false });
                res.end();
                return;
              }
            }

            // Run init command
            if (repoConfig.initCommand) {
              sendEvent({ type: "step", text: `Running init command: ${repoConfig.initCommand}` });
              const code = await runCommand(repoConfig.initCommand, targetWorktreePath);
              if (code !== 0) {
                sendEvent({ type: "step", text: `Init command exited with code ${code} (continuing anyway)` });
              } else {
                sendEvent({ type: "step", text: "Init command completed" });
              }
            }
          }

          // Register task in the registry
          const taskRecord = await registerTask({
            pid: 0, // PID unknown until terminal spawns the command
            repoPath: parsed.repoPath,
            worktreePath: targetWorktreePath,
            poolPrefix: parsed.poolPrefix,
            poolName: parsed.poolPrefix,
            branch: resolvedBranch ?? "",
            prompt: parsed.prompt,
            taskCommand: parsed.taskCommand || "",
            launchedBy: "web",
          });

          sendEvent({ type: "done", success: true, worktreePath: targetWorktreePath, taskId: taskRecord.id });
        } catch (err: any) {
          sendEvent({ type: "error", text: `Unexpected error: ${err.message}` });
          sendEvent({ type: "done", success: false });
        }

        res.end();
        return;
      }

      // Static files (HTML, JS, CSS, images) served without token.
      // The token in the URL is read by the JS client for API auth.
      if (hasStaticFiles) {
        let filePath = pathname === "/" ? path.join(distDir, "index.html") : path.join(distDir, pathname);
        const result = await serveStaticFile(filePath);
        res.writeHead(result.status, { "Content-Type": result.contentType });
        res.end(result.body);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found (frontend not built, use Vite dev server)");
      }
    } catch (error) {
      console.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

  // WebSocket server for terminal sessions
  const wss = new WebSocketServer({ noServer: true });
  // WebSocket server for subscriptions (push-based updates)
  const subscribeWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    // Auth check
    const queryToken = url.searchParams.get("token");
    if (queryToken !== token) {
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws/terminal") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else if (url.pathname === "/ws/subscribe") {
      subscribeWss.handleUpgrade(req, socket, head, (ws) => {
        subscribeWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let attachedTerminalId: string | null = null;

    const dataListener = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", terminalId: attachedTerminalId, data }));
      }
    };

    const exitListener = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", terminalId: attachedTerminalId }));
      }
    };

    ws.on("message", async (rawMsg) => {
      let msg: any;
      try {
        msg = JSON.parse(rawMsg.toString());
      } catch {
        return;
      }

      const { type, terminalId } = msg;

      switch (type) {
        case "create": {
          const { worktreePath, cols, rows, env, initialCommand, taskId } = msg;
          // Find which repo this worktree belongs to so we can get its terminalLogDir
          let terminalLogDir: string | null = null;
          const appData = await loadAppData();
          for (const [repoPath, cfg] of Object.entries(appData.repositoryConfigs)) {
            const worktreeDir = (cfg as any).worktreeDirectory || path.dirname(repoPath);
            if (worktreePath === repoPath || worktreePath.startsWith(worktreeDir + path.sep)) {
              terminalLogDir = (cfg as any).terminalLogDir || null;
              break;
            }
          }
          const existed = terminalManager.createSession(terminalId, worktreePath, cols || 80, rows || 24, env, initialCommand, terminalLogDir);

          // If this terminal is associated with a task, update the task PID and track exit
          if (taskId && !existed) {
            const pid = terminalManager.getSessionPid(terminalId);
            if (pid) {
              updateTaskPid(taskId, pid).catch(() => {});
            }

            // Listen for exit to mark task completed
            const taskExitListener = () => {
              markTaskCompleted(taskId, 0).catch(() => {});
            };
            terminalManager.addExitListener(terminalId, taskExitListener);
          }

          // Detach from previous terminal if switching
          if (attachedTerminalId && attachedTerminalId !== terminalId) {
            terminalManager.removeDataListener(attachedTerminalId, dataListener);
            terminalManager.removeExitListener(attachedTerminalId, exitListener);
          }

          attachedTerminalId = terminalId;
          terminalManager.addDataListener(terminalId, dataListener);
          terminalManager.addExitListener(terminalId, exitListener);

          // Send buffered output for reconnection
          if (existed) {
            const buffered = terminalManager.getBufferedOutput(terminalId);
            if (buffered) {
              ws.send(JSON.stringify({ type: "buffered", terminalId, data: buffered }));
            }
          }
          break;
        }

        case "data": {
          terminalManager.sendData(terminalId, msg.data);
          break;
        }

        case "resize": {
          terminalManager.resize(terminalId, msg.cols, msg.rows);
          break;
        }

        case "close": {
          terminalManager.closeSession(terminalId);
          break;
        }
      }
    });

    ws.on("close", () => {
      // Client disconnected - detach listeners but keep PTY alive
      if (attachedTerminalId) {
        terminalManager.removeDataListener(attachedTerminalId, dataListener);
        terminalManager.removeExitListener(attachedTerminalId, exitListener);
      }
    });
  });

  // --- Subscription system: push worktree updates when git state changes ---
  const repoWatcher = new RepoWatcher();

  // Track which repos each subscriber is watching
  const subscriberRepos = new Map<WebSocket, Set<string>>();

  // Start watching all known repos
  const appDataForWatch = await loadAppData();
  for (const repo of appDataForWatch.repositories) {
    repoWatcher.watchRepo(repo.path).catch(() => {});
  }

  // When git state changes, broadcast updated worktree list to subscribers
  repoWatcher.on("changed", async (repoPath: string) => {
    try {
      const worktrees = await gitPool.getWorktrees(repoPath);
      const message = JSON.stringify({
        type: "worktrees",
        repoPath,
        data: worktrees,
      });

      for (const [ws, repos] of subscriberRepos) {
        if (repos.has(repoPath) && ws.readyState === WebSocket.OPEN) {
          ws.send(message);
        }
      }
    } catch {
      // Failed to get worktrees — skip this update
    }
  });

  subscribeWss.on("connection", (ws: WebSocket) => {
    subscriberRepos.set(ws, new Set());

    ws.on("message", async (rawMsg) => {
      let msg: any;
      try {
        msg = JSON.parse(rawMsg.toString());
      } catch {
        return;
      }

      if (msg.type === "subscribe" && msg.procedure === "worktrees" && msg.repoPath) {
        const repos = subscriberRepos.get(ws);
        if (repos) {
          repos.add(msg.repoPath);

          // Start watching this repo if not already
          await repoWatcher.watchRepo(msg.repoPath).catch(() => {});

          // Send initial data immediately
          try {
            const worktrees = await gitPool.getWorktrees(msg.repoPath);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "worktrees",
                repoPath: msg.repoPath,
                data: worktrees,
              }));
            }
          } catch {
            // ignore
          }
        }
      } else if (msg.type === "unsubscribe" && msg.procedure === "worktrees" && msg.repoPath) {
        const repos = subscriberRepos.get(ws);
        if (repos) {
          repos.delete(msg.repoPath);
        }
      }
    });

    ws.on("close", () => {
      subscriberRepos.delete(ws);
    });
  });

  // Cleanup on server shutdown — save terminal logs before exiting
  const cleanupAndExit = async () => {
    repoWatcher.close();

    // Save terminal output as read-only logs
    try {
      const { getTaskLogDir } = await import("../cli/task-registry.js");
      const logDir = getTaskLogDir();
      const saved = await terminalManager.saveAllSessionLogs(logDir);

      if (saved.length > 0) {
        // Figure out repo paths from app data
        const appData = await loadAppData();
        for (const entry of saved) {
          let repoPath = "";
          let branch = "";
          for (const [rp, cfg] of Object.entries(appData.repositoryConfigs)) {
            const worktreeDir = (cfg as any).worktreeDirectory || path.dirname(rp);
            if (entry.worktreePath === rp || entry.worktreePath.startsWith(worktreeDir + path.sep)) {
              repoPath = rp;
              break;
            }
          }
          // Try to get branch name
          try {
            const { simpleGit } = await import("simple-git");
            const git = simpleGit(entry.worktreePath);
            const status = await git.status();
            branch = status.current || "";
          } catch {}

          const task = await registerTask({
            pid: 0,
            repoPath,
            worktreePath: entry.worktreePath,
            poolPrefix: "",
            poolName: "",
            branch,
            prompt: "Terminal session (saved on shutdown)",
            taskCommand: "",
            logFile: entry.logFile,
            launchedBy: "web",
          });
          await markTaskCompleted(task.id, 0);
        }
      }
    } catch (err) {
      console.error("Failed to save terminal logs on shutdown:", err);
    }

    terminalManager.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", cleanupAndExit);
  process.on("SIGTERM", cleanupAndExit);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actualPort = (server.address() as AddressInfo).port;
      const serverUrl = `http://${host}:${actualPort}?token=${token}`;

      console.log(`\nMany Web Server running at ${serverUrl}`);
      console.log("Press Ctrl+C to stop the server.\n");

      if (options.open) {
        const platform = process.platform;

        if (platform === "darwin") {
          exec(`open "${serverUrl}"`);
        } else if (platform === "win32") {
          exec(`start "${serverUrl}"`);
        } else {
          exec(`xdg-open "${serverUrl}"`);
        }
      }

      resolve({ url: serverUrl, port: actualPort });
    });
  });
}
