/**
 * RPC query and subscription handlers.
 * Each handler delegates to the existing service layer — no business logic here.
 */

import path from "path";
import { promises as fs, watch, type FSWatcher } from "fs";
import { spawn, execSync } from "child_process";
import logger from "../shared/logger.js";
import type { QueryHandler, SubscriptionHandler } from "./rpc-server.js";
import type { QueryProcedure, SubscriptionProcedure, StreamEvent, FsEntry } from "../shared/protocol.js";
import { loadAppData, withAppData, getRepoConfig, getGlobalSettings } from "../cli/config.js";
import { getTrackedBranches, addTrackedBranch, removeTrackedBranch, reorderTrackedBranches } from "../cli/db.js";
import {
  registerTask,
  markTaskCompleted,
  updateTaskPid,
  reconcileTasks,
  listTasks as listTaskRecords,
  killTask as killTaskById,
} from "../cli/task-registry.js";
import * as gitPool from "../cli/git-pool.js";
import { TerminalManager } from "./terminal-manager.js";
import { getClaudeSessions, getSessionMessages } from "./claude-sessions.js";
import { computeWorktreeActivityTimes } from "./worktree-activity.js";
import { RepoWatcher } from "./git-watcher.js";
import {
  resolveStartingPoint,
  archiveWorktree as serviceArchiveWorktree,
  createAndSetupWorktree,
  launchTask,
  claimWorktreeByPath,
  releaseWorktreeByPath,
  getBranches,
  getGitUsername,
  checkBranchMergedByName,
  mergeWorktree,
  rebaseWorktree,
  getCommitLog,
  getBranchDiff,
  getGitHubLink,
  getLinearLink,
  getGitHubRepo,
  assignPrToMe,
  getBranchStack,
  checkoutBranch,
  getWorktrees,
  getWorktreesFromFS,
  getWorktreeStatus,
  getDefaultBranchForConfig,
  createWorktree,
  stashChanges,
  cleanChanges,
  amendChanges,
  commitChanges,
  isTmpBranch,
} from "../services/worktree-service.js";
import type { RunCommand } from "../services/types.js";

// Import ClaudeService and SessionStore types — instantiated externally
import { ClaudeService } from "../claude-session/server/claude-service.js";
import { SessionStore } from "../claude-session/server/session-store.js";

const userShell = process.env.SHELL || "/bin/bash";

// ---------------------------------------------------------------------------
// Mux server URL discovery
// ---------------------------------------------------------------------------

let _cachedMuxUrl: string | null | undefined;

async function getMuxWsUrl(): Promise<string | null> {
  if (_cachedMuxUrl !== undefined) return _cachedMuxUrl;
  try {
    const result = execSync("mux-url", { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    _cachedMuxUrl = result || null;
  } catch {
    _cachedMuxUrl = null;
  }
  setTimeout(() => { _cachedMuxUrl = undefined; }, 30_000);
  return _cachedMuxUrl;
}

// ---------------------------------------------------------------------------
// External action helpers (same as server.ts originals)
// ---------------------------------------------------------------------------

function spawnDetached(command: string, args: string[], opts?: { cwd?: string }): void {
  logger.info(`[action] spawning: ${command} ${args.join(" ")}${opts?.cwd ? ` (cwd: ${opts.cwd})` : ""}`);
  const child = spawn(command, args, { detached: true, stdio: "ignore", ...opts });
  child.on("error", (err) => {
    logger.error(`[action] spawn failed for ${command}: ${err.message}`);
  });
  child.unref();
}

async function openInFileManager(folderPath: string): Promise<boolean> {
  const platform = process.platform;
  if (platform === "darwin") spawnDetached("open", [folderPath]);
  else if (platform === "win32") spawnDetached("explorer", [folderPath]);
  else spawnDetached("xdg-open", [folderPath]);
  return true;
}

/** Map CLI editor names to macOS app names for `open -a` */
const editorAppNames: Record<string, string> = {
  code: "Visual Studio Code",
  cursor: "Cursor",
  subl: "Sublime Text",
  atom: "Atom",
  zed: "Zed",
};

async function openInEditor(folderPath: string, editor?: string | null): Promise<boolean> {
  logger.info(`[action] openInEditor: path=${folderPath}, editor=${editor ?? "(auto-detect)"}`);

  if (process.platform === "darwin") {
    // On macOS, prefer `open -a <AppName>` which works reliably in Electron
    // (spawning CLI tools directly often fails due to PATH issues)
    if (editor) {
      const appName = editorAppNames[editor];
      if (appName) {
        spawnDetached("open", ["-a", appName, folderPath]);
        return true;
      }
      // If it looks like an app name (contains spaces or .app), use open -a directly
      if (editor.includes(" ") || editor.endsWith(".app")) {
        spawnDetached("open", ["-a", editor, folderPath]);
        return true;
      }
      // Otherwise run through login shell to get proper PATH
      spawnDetached(userShell, ["-l", "-c", `${editor} ${JSON.stringify(folderPath)}`]);
      return true;
    }
    // Auto-detect: try known editors via open -a
    for (const [, appName] of Object.entries(editorAppNames)) {
      try {
        execSync(`mdfind "kMDItemKind == 'Application'" | grep -q "${appName}"`, { stdio: "ignore" });
        spawnDetached("open", ["-a", appName, folderPath]);
        return true;
      } catch { continue; }
    }
    return openInFileManager(folderPath);
  }

  // Non-macOS: spawn directly
  if (editor) { spawnDetached(editor, [folderPath]); return true; }
  for (const ed of ["code", "cursor", "subl", "atom"]) {
    try { spawnDetached(ed, [folderPath]); return true; } catch { continue; }
  }
  logger.warn("[action] openInEditor: no editor found, falling back to file manager");
  return openInFileManager(folderPath);
}

async function openInTerminal(folderPath: string, terminal?: string | null): Promise<boolean> {
  logger.info(`[action] openInTerminal: path=${folderPath}, terminal=${terminal ?? "(default)"}`);
  const platform = process.platform;
  if (terminal) {
    if (platform === "darwin") spawnDetached("open", ["-a", terminal, folderPath]);
    else spawnDetached(terminal, [], { cwd: folderPath });
    return true;
  }
  if (platform === "darwin") spawnDetached("open", ["-a", "Terminal", folderPath]);
  else if (platform === "win32") spawnDetached("cmd", ["/c", "start", "cmd", "/k", `cd /d "${folderPath}"`]);
  return true;
}

async function openVSCode(dirPath: string): Promise<boolean> {
  const cmd = `${userShell} -l -c ${JSON.stringify(`code "${dirPath}"`)}`;
  logger.info(`[action] openVSCode: ${cmd}`);
  const { promisify } = await import("util");
  const { exec } = await import("child_process");
  await promisify(exec)(cmd);
  return true;
}

// Read a file's contents for the editor, flagging files too large to edit or
// containing binary data.
async function readFileForEditor(
  filePath: string
): Promise<{ content: string; size: number; tooLarge: boolean; binary: boolean }> {
  const MAX_BYTES = 512 * 1024;
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_BYTES) {
    return { content: "", size: stat.size, tooLarge: true, binary: false };
  }
  const buf = await fs.readFile(filePath);
  const binary = buf.subarray(0, 8192).includes(0);
  if (binary) {
    return { content: "", size: stat.size, tooLarge: false, binary: true };
  }
  return { content: buf.toString("utf-8"), size: stat.size, tooLarge: false, binary: false };
}

// Read a directory's immediate children, sorted dirs-first then by name.
async function listDirEntries(dirPath: string): Promise<FsEntry[]> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries = dirents.map((d) => ({
    name: d.name,
    path: path.join(dirPath, d.name),
    isDirectory: d.isDirectory(),
  }));
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Factory: create handlers with shared dependencies
// ---------------------------------------------------------------------------

export function createQueryHandlers(opts: {
  terminalManager: TerminalManager;
  claudeService: ClaudeService;
  sessionStore: SessionStore;
}): Partial<Record<QueryProcedure, QueryHandler>> {
  const { terminalManager, claudeService, sessionStore } = opts;

  return {
    // --- Worktree ---
    "worktree.list": async (input) => {
      const { repoPath } = input as { repoPath: string };
      return getWorktrees(repoPath);
    },
    "worktree.status": async (input) => {
      const { worktreePath } = input as { worktreePath: string };
      return getWorktreeStatus(worktreePath);
    },
    "worktree.commitLog": async (input) => {
      const { worktreePath, baseBranch } = input as { worktreePath: string; baseBranch?: string };
      return getCommitLog(worktreePath, baseBranch ?? "");
    },
    "worktree.branchDiff": async (input) => {
      const { worktreePath, repoPath } = input as { worktreePath: string; repoPath: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return getBranchDiff(worktreePath, repoPath, repoConfig.mainBranch);
    },
    "worktree.archive": async (input) => {
      const { repoPath, worktreePath, force } = input as { repoPath: string; worktreePath: string; force?: boolean };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      terminalManager.cleanupWorktree(worktreePath);
      await serviceArchiveWorktree(repoPath, worktreePath, { force, mainBranch: repoConfig.mainBranch });
      return { ok: true };
    },
    "worktree.create": async (input) => {
      const { repoPath, branchName } = input as { repoPath: string; branchName: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return createWorktree(repoPath, branchName, repoConfig);
    },
    "worktree.createPool": async (input) => {
      const { repoPath, worktreeName } = input as { repoPath: string; worktreeName: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return createWorktree(repoPath, worktreeName, repoConfig);
    },
    "worktree.claim": async (input) => {
      const { repoPath, worktreePath, branchName } = input as { repoPath: string; worktreePath: string; branchName: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      await claimWorktreeByPath(repoPath, worktreePath, branchName, repoConfig.mainBranch);
      return { ok: true };
    },
    "worktree.release": async (input) => {
      const { repoPath, worktreePath, force } = input as { repoPath: string; worktreePath: string; force?: boolean };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      terminalManager.cleanupWorktree(worktreePath);
      await releaseWorktreeByPath(repoPath, worktreePath, repoConfig.mainBranch, force ?? false);
      return { ok: true };
    },
    "worktree.stash": async (input) => {
      const { worktreePath, message } = input as { worktreePath: string; message?: string };
      await stashChanges(worktreePath, message);
      return { ok: true };
    },
    "worktree.clean": async (input) => {
      const { worktreePath } = input as { worktreePath: string };
      await cleanChanges(worktreePath);
      return { ok: true };
    },
    "worktree.amend": async (input) => {
      const { worktreePath, noVerify } = input as { worktreePath: string; noVerify?: boolean };
      await amendChanges(worktreePath, { noVerify });
      return { ok: true };
    },
    "worktree.commit": async (input) => {
      const { worktreePath, message, noVerify } = input as { worktreePath: string; message: string; noVerify?: boolean };
      await commitChanges(worktreePath, message, { noVerify });
      return { ok: true };
    },
    "worktree.merge": async (input) => {
      const { repoPath, fromBranch, toBranch, options } = input as any;
      await mergeWorktree(repoPath, fromBranch, toBranch, options);
      return { ok: true };
    },
    "worktree.rebase": async (input) => {
      const { worktreePath, fromBranch, ontoBranch } = input as any;
      await rebaseWorktree(worktreePath, fromBranch, ontoBranch);
      return { ok: true };
    },
    "worktree.runMaintenance": async (input) => {
      const { worktreePath, command } = input as { worktreePath: string; command: string };
      execSync(command, { cwd: worktreePath, stdio: "pipe", timeout: 120000 });
      return { ok: true };
    },

    // --- Worktree starring & ordering ---
    "worktree.getStarred": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return (appData.starredWorktrees ?? {})[repoPath] ?? [];
    },
    "worktree.setStarred": async (input) => {
      const { repoPath, worktreePath, starred } = input as { repoPath: string; worktreePath: string; starred: boolean };
      await withAppData((appData) => {
        if (!appData.starredWorktrees) appData.starredWorktrees = {};
        const list = appData.starredWorktrees[repoPath] ?? [];
        if (starred && !list.includes(worktreePath)) {
          list.push(worktreePath);
        } else if (!starred) {
          const idx = list.indexOf(worktreePath);
          if (idx >= 0) list.splice(idx, 1);
        }
        appData.starredWorktrees[repoPath] = list;
      });

      // When starring, assign the PR (if any) to the current gh user
      if (starred) {
        const wts = await getWorktrees(repoPath);
        const wt = wts.find(w => w.path === worktreePath);
        if (wt?.branch) {
          assignPrToMe(repoPath, wt.branch).catch(() => {});
        }
      }

      return { ok: true };
    },
    // --- Folder pinning (Active list) ---
    "folder.getPinned": async () => {
      const appData = await loadAppData();
      return appData.pinnedFolders ?? [];
    },
    "folder.setPinned": async (input) => {
      const { path, pinned } = input as { path: string; pinned: boolean };
      await withAppData((appData) => {
        const list = appData.pinnedFolders ?? [];
        if (pinned && !list.includes(path)) {
          list.push(path);
        } else if (!pinned) {
          const idx = list.indexOf(path);
          if (idx >= 0) list.splice(idx, 1);
        }
        appData.pinnedFolders = list;
      });
      return { ok: true };
    },
    "worktree.getOrder": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return (appData.worktreeOrder ?? {})[repoPath] ?? [];
    },
    "worktree.setOrder": async (input) => {
      const { repoPath, order } = input as { repoPath: string; order: string[] };
      await withAppData((appData) => {
        if (!appData.worktreeOrder) appData.worktreeOrder = {};
        appData.worktreeOrder[repoPath] = order;
      });
      return { ok: true };
    },
    // --- Tracked branches ---
    "tracked.list": async (input) => {
      const { repoPath } = input as { repoPath: string };
      return getTrackedBranches(repoPath);
    },
    "tracked.add": async (input) => {
      const { repoPath, input: rawInput } = input as { repoPath: string; input: string };
      const trimmed = rawInput.trim();
      let branch = trimmed.replace(/^refs\/heads\//, "");

      // Resolve PR URL or number to branch name
      const prUrlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
      const prNumberMatch = trimmed.match(/^#?(\d+)$/);
      if (prUrlMatch || prNumberMatch) {
        const prRef = prUrlMatch ? trimmed : trimmed.replace(/^#/, '');
        try {
          const resolved = execSync(
            `gh pr view ${JSON.stringify(prRef)} --json headRefName --jq .headRefName`,
            { cwd: repoPath, encoding: "utf-8", timeout: 10000 }
          ).trim();
          if (resolved) branch = resolved;
        } catch {
          // If gh fails, use the input as-is
        }
      }

      addTrackedBranch(repoPath, branch);
      return { branch };
    },
    "tracked.remove": async (input) => {
      const { repoPath, branch } = input as { repoPath: string; branch: string };
      removeTrackedBranch(repoPath, branch);
      return { ok: true };
    },
    "tracked.reorder": async (input) => {
      const { repoPath, branches } = input as { repoPath: string; branches: string[] };
      reorderTrackedBranches(repoPath, branches);
      return { ok: true };
    },

    // --- Worktree activity ---
    "worktree.activity": async () => {
      const terminalCounts = terminalManager.getSessionCountsByWorktree();
      const claudeCounts = claudeService.getSessionCountsByCwd();
      const allPaths = new Set([...Object.keys(terminalCounts), ...Object.keys(claudeCounts)]);
      const result: Record<string, { terminals: number; claudeSessions: number }> = {};
      for (const p of allPaths) {
        result[p] = {
          terminals: terminalCounts[p] || 0,
          claudeSessions: claudeCounts[p] || 0,
        };
      }
      return result;
    },

    // --- Branch ---
    "branch.list": async (input) => {
      const { repoPath } = input as { repoPath: string };
      return getBranches(repoPath);
    },
    "branch.checkMerged": async (input) => {
      const { repoPath, branch, mainBranch } = input as { repoPath: string; branch: string; mainBranch?: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return checkBranchMergedByName(repoPath, branch, mainBranch ?? repoConfig.mainBranch);
    },
    "branch.isTmp": async (input) => {
      const { branch } = input as { branch: string };
      return isTmpBranch(branch);
    },
    "branch.defaultBranch": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return getDefaultBranchForConfig(repoPath, repoConfig);
    },
    "branch.resolveStartingPoint": async (input) => {
      const { repoPath, startingPoint, pullLatest } = input as { repoPath: string; startingPoint?: string; pullLatest?: boolean };
      const branchName = await resolveStartingPoint(repoPath, startingPoint ?? "");
      return { startingPoint: branchName };
    },
    "branch.stack": async (input) => {
      const { worktreePath, repoPath } = input as { worktreePath: string; repoPath: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return getBranchStack(worktreePath, repoPath, repoConfig.mainBranch);
    },
    "branch.checkout": async (input) => {
      const { worktreePath, branch } = input as { worktreePath: string; branch: string };
      await checkoutBranch(worktreePath, branch);
      return { ok: true };
    },

    // --- Repository ---
    "repo.list": async () => {
      const appData = await loadAppData();
      return appData.repositories;
    },
    "repo.add": async (input) => {
      const { repoPath } = input as { repoPath: string };
      // Validate that the path exists and is a git repository
      try {
        await fs.access(repoPath);
      } catch {
        throw new Error(`Path does not exist: ${repoPath}`);
      }
      try {
        await gitPool.getWorktrees(repoPath);
      } catch {
        throw new Error(`Not a git repository: ${repoPath}`);
      }
      await withAppData((appData) => {
        if (!appData.repositories.some((r: any) => r.path === repoPath)) {
          appData.repositories.push({ path: repoPath, name: path.basename(repoPath), addedAt: new Date().toISOString() });
        }
      });
      return { ok: true };
    },

    // --- Projects ---
    "projects.list": async () => {
      const appData = await loadAppData();
      return appData.projects ?? [];
    },
    "projects.add": async (input) => {
      const { projectPath } = input as { projectPath: string };
      let stat: import("fs").Stats;
      try {
        stat = await fs.stat(projectPath);
      } catch {
        throw new Error(`Path does not exist: ${projectPath}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${projectPath}`);
      }
      await withAppData((appData) => {
        if (!appData.projects) appData.projects = [];
        if (!appData.projects.some((p) => p.path === projectPath)) {
          appData.projects.push({ path: projectPath, name: path.basename(projectPath), addedAt: new Date().toISOString() });
        }
      });
      return { ok: true };
    },
    "projects.remove": async (input) => {
      const { projectPath } = input as { projectPath: string };
      await withAppData((appData) => {
        if (!appData.projects) return;
        const idx = appData.projects.findIndex((p) => p.path === projectPath);
        if (idx >= 0) appData.projects.splice(idx, 1);
      });
      return { ok: true };
    },

    // --- Filesystem (read-only browsing for projects) ---
    "fs.listDir": async (input) => {
      const { dirPath } = input as { dirPath: string };
      try {
        return await listDirEntries(dirPath);
      } catch (err) {
        throw new Error(`Cannot read directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    "fs.search": async (input) => {
      const { dirPath, query } = input as { dirPath: string; query: string };
      const q = query.trim().toLowerCase();
      if (!q) return {};
      const SKIP = new Set([".git", "node_modules"]);
      const MAX_RESULTS = 1000;
      const MAX_DEPTH = 24;
      const result: Record<string, FsEntry[]> = {};
      let count = 0;

      const walk = async (dir: string, depth: number): Promise<boolean> => {
        if (depth > MAX_DEPTH || count >= MAX_RESULTS) return false;
        let dirents: import("fs").Dirent[];
        try {
          dirents = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return false;
        }
        let matched = false;
        for (const d of dirents) {
          if (count >= MAX_RESULTS) break;
          if (SKIP.has(d.name)) continue;
          const full = path.join(dir, d.name);
          const entry = { name: d.name, path: full, isDirectory: d.isDirectory() };
          if (d.isDirectory()) {
            const childMatched = await walk(full, depth + 1);
            if (childMatched || d.name.toLowerCase().includes(q)) {
              (result[dir] ??= []).push(entry);
              matched = true;
            }
          } else if (d.name.toLowerCase().includes(q)) {
            (result[dir] ??= []).push(entry);
            matched = true;
            count++;
          }
        }
        return matched;
      };

      await walk(dirPath, 0);
      for (const key of Object.keys(result)) {
        result[key].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      }
      return result;
    },
    "fs.readFile": async (input) => {
      const { filePath } = input as { filePath: string };
      try {
        return await readFileForEditor(filePath);
      } catch (err) {
        throw new Error(`Cannot read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    "fs.writeFile": async (input) => {
      const { filePath, content } = input as { filePath: string; content: string };
      try {
        await fs.writeFile(filePath, content, "utf-8");
      } catch (err) {
        throw new Error(`Cannot write file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true };
    },
    "fs.createFile": async (input) => {
      const { filePath } = input as { filePath: string };
      try {
        // wx: fail if the path already exists, so we never clobber a file.
        const handle = await fs.open(filePath, "wx");
        await handle.close();
      } catch (err) {
        throw new Error(`Cannot create file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true };
    },
    "fs.createDir": async (input) => {
      const { dirPath } = input as { dirPath: string };
      try {
        await fs.mkdir(dirPath);
      } catch (err) {
        throw new Error(`Cannot create directory ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true };
    },
    "fs.rename": async (input) => {
      const { oldPath, newPath } = input as { oldPath: string; newPath: string };
      let destExists = false;
      try {
        await fs.access(newPath);
        destExists = true;
      } catch {
        // ENOENT is the expected case: the destination name is free.
      }
      if (destExists) throw new Error(`Destination already exists: ${newPath}`);
      try {
        await fs.rename(oldPath, newPath);
      } catch (err) {
        throw new Error(`Cannot rename ${oldPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true };
    },
    "fs.delete": async (input) => {
      const { path: targetPath } = input as { path: string };
      try {
        await fs.rm(targetPath, { recursive: true, force: false });
      } catch (err) {
        throw new Error(`Cannot delete ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true };
    },

    "repo.getSelected": async () => {
      const appData = await loadAppData();
      return appData.selectedRepo;
    },
    "repo.setSelected": async (input) => {
      const { repoPath } = input as { repoPath: string | null };
      await withAppData((appData) => {
        appData.selectedRepo = repoPath;
      });
      return { ok: true };
    },
    "repo.getConfig": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return getRepoConfig(appData, repoPath);
    },
    "repo.saveConfig": async (input) => {
      const { repoPath, config } = input as { repoPath: string; config: any };
      await withAppData((appData) => {
        appData.repositoryConfigs[repoPath] = config;
      });
      return { ok: true };
    },
    "repo.recentWorktree": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return appData.recentWorktrees[repoPath] || null;
    },
    "repo.setRecentWorktree": async (input) => {
      const { repoPath, worktreePath } = input as { repoPath: string; worktreePath: string };
      await withAppData((appData) => {
        appData.recentWorktrees[repoPath] = worktreePath;
      });
      return { ok: true };
    },
    "repo.gitUsername": async (input) => {
      const { repoPath } = input as { repoPath: string };
      return getGitUsername(repoPath);
    },
    "repo.githubLink": async (input) => {
      const { repoPath, branch } = input as { repoPath: string; branch: string };
      return getGitHubLink(repoPath, branch);
    },
    "repo.linearLink": async (input) => {
      const { repoPath, branch } = input as { repoPath: string; branch: string };
      return getLinearLink(repoPath, branch);
    },

    // --- Settings ---
    "settings.get": async () => {
      const appData = await loadAppData();
      return getGlobalSettings(appData);
    },
    "settings.save": async (input) => {
      await withAppData((appData) => {
        appData.globalSettings = input as any;
      });
      return { ok: true };
    },
    "settings.muxUrl": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const [wsUrl, repo] = await Promise.all([getMuxWsUrl(), getGitHubRepo(repoPath)]);
      return { wsUrl, repo };
    },

    // --- Actions ---
    "action.openFileManager": async (input) => {
      const { path: p } = input as { path: string };
      await openInFileManager(p);
      return { ok: true };
    },
    "action.openEditor": async (input) => {
      const { path: p, editor } = input as { path: string; editor?: string | null };
      const appData = await loadAppData();
      const settings = getGlobalSettings(appData);
      await openInEditor(p, editor ?? settings.defaultEditor);
      return { ok: true };
    },
    "action.openTerminal": async (input) => {
      const { path: p, terminal } = input as { path: string; terminal?: string | null };
      const appData = await loadAppData();
      const settings = getGlobalSettings(appData);
      await openInTerminal(p, terminal ?? settings.defaultTerminal);
      return { ok: true };
    },
    "action.openDirectory": async (input) => {
      const { path: p } = input as { path: string };
      await openInFileManager(p);
      return { ok: true };
    },
    "action.openTerminalInDir": async (input) => {
      const { path: p, terminal } = input as { path: string; terminal?: string | null };
      const appData = await loadAppData();
      const settings = getGlobalSettings(appData);
      await openInTerminal(p, terminal ?? settings.defaultTerminal);
      return { ok: true };
    },
    "action.openVSCode": async (input) => {
      const { path: p } = input as { path: string };
      await openVSCode(p);
      return { ok: true };
    },
    "action.selectFolder": async (input) => {
      const { initialPath } = input as { initialPath?: string };
      try {
        const { dialog } = await import("electron");
        const result = await dialog.showOpenDialog({
          ...(initialPath ? { defaultPath: initialPath } : {}),
          properties: ["openDirectory", "createDirectory"],
        });
        return { path: result.canceled ? null : result.filePaths[0] };
      } catch {
        throw new Error("Folder picker is only available in the Electron app");
      }
    },

    // --- Tasks ---
    "task.list": async (input) => {
      const { repoPath } = input as { repoPath: string };
      await reconcileTasks();
      return listTaskRecords({ repoPath });
    },
    "task.kill": async (input) => {
      const { taskId } = input as { taskId: string };
      await killTaskById(taskId);
      return { ok: true };
    },
    "task.getLog": async (input) => {
      const { taskId, offset } = input as { taskId: string; offset?: number };
      const { getTask } = await import("../cli/task-registry.js");
      const task = await getTask(taskId);
      if (!task?.logFile) return { content: "", size: 0 };
      try {
        const stat = await fs.stat(task.logFile);
        const start = Math.max(offset ?? 0, 0);
        const maxRead = 100 * 1024;
        const fh = await fs.open(task.logFile, "r");
        const buf = Buffer.alloc(Math.min(maxRead, stat.size - start));
        if (buf.length > 0) await fh.read(buf, 0, buf.length, start);
        await fh.close();
        return { content: buf.toString("utf-8"), size: stat.size };
      } catch {
        return { content: "", size: 0 };
      }
    },

    // --- Terminal ---
    "terminal.create": async (input) => {
      const msg = input as {
        terminalId: string; worktreePath: string; cols: number; rows: number;
        isDark: boolean; env?: Record<string, string>; initialCommand?: string; taskId?: string;
      };
      let terminalLogDir: string | null = null;
      const appData = await loadAppData();
      for (const [repoPath, cfg] of Object.entries(appData.repositoryConfigs)) {
        const worktreeDir = (cfg as any).worktreeDirectory || path.dirname(repoPath);
        if (msg.worktreePath === repoPath || msg.worktreePath.startsWith(worktreeDir + path.sep)) {
          terminalLogDir = (cfg as any).terminalLogDir || null;
          break;
        }
      }
      const colorEnv: Record<string, string> = {};
      if (msg.isDark) colorEnv.COLORFGBG = "15;0";
      else colorEnv.COLORFGBG = "0;15";
      const mergedEnv = { ...colorEnv, ...msg.env };
      const existed = terminalManager.createSession(msg.terminalId, msg.worktreePath, msg.cols || 80, msg.rows || 24, mergedEnv, msg.initialCommand, terminalLogDir);

      if (msg.taskId && !existed) {
        const pid = terminalManager.getSessionPid(msg.terminalId);
        if (pid) updateTaskPid(msg.taskId, pid).catch(() => {});
        terminalManager.addExitListener(msg.terminalId, () => {
          markTaskCompleted(msg.taskId!, 0).catch(() => {});
        });
      }

      return { existed: !!existed };
    },
    "terminal.input": async (input) => {
      const { terminalId, data } = input as { terminalId: string; data: string };
      terminalManager.sendData(terminalId, data);
      return { ok: true };
    },
    "terminal.resize": async (input) => {
      const { terminalId, cols, rows } = input as { terminalId: string; cols: number; rows: number };
      terminalManager.resize(terminalId, cols, rows);
      return { ok: true };
    },
    "terminal.close": async (input) => {
      const { terminalId } = input as { terminalId: string };
      terminalManager.closeSession(terminalId);
      return { ok: true };
    },
    "terminal.listSessions": async (input) => {
      const { worktreePath } = input as { worktreePath: string };
      return terminalManager.getSessionsForWorktree(worktreePath);
    },

    // --- Claude sessions (existing read-only discovery) ---
    "claude.sessions": async (input) => {
      const { worktreePath } = input as { worktreePath: string };
      const sessions = await getClaudeSessions(worktreePath);
      const appData = await loadAppData();
      const meta = appData.sessionMeta || {};
      for (const s of sessions) {
        const m = meta[s.sessionId];
        if (m) {
          s.sessionType = m.type;
          s.closed = m.closed;
        }
      }
      return sessions;
    },
    "claude.sessionMessages": async (input) => {
      const { sessionId, worktreePath, offset, limit } = input as any;
      return getSessionMessages(sessionId, worktreePath, offset, limit);
    },
    "claude.setSessionMeta": async (input) => {
      const { sessionId, type, closed } = input as { sessionId: string; type?: "chat" | "claude-code"; closed?: boolean };
      await withAppData((appData) => {
        if (!appData.sessionMeta) appData.sessionMeta = {};
        const existing = appData.sessionMeta[sessionId] || { type: type || "claude-code" };
        if (type !== undefined) existing.type = type;
        if (closed !== undefined) existing.closed = closed;
        appData.sessionMeta[sessionId] = existing;
      });
      return { ok: true };
    },

    // --- Claude session service (live interactive) ---
    "session.list": async (input) => {
      const { dir, limit, offset } = input as { dir: string; limit?: number; offset?: number };
      const sessions = await sessionStore.listSessions({ dir, limit, offset });
      for (const s of sessions) s.isActive = claudeService.isActive(s.sessionId);
      return sessions;
    },
    "session.messages": async (input) => {
      const inp = input as { sessionId: string; dir?: string; limit?: number; offset?: number };
      return sessionStore.getMessages(inp);
    },
    "session.start": async (input) => {
      const inp = input as { cwd: string; prompt?: string; sessionId?: string; permissionMode?: string };
      const sessionId = await claudeService.start({
        cwd: inp.cwd,
        prompt: inp.prompt,
        sessionId: inp.sessionId,
        permissionMode: (inp.permissionMode ?? "bypassPermissions") as any,
      });
      await withAppData((appData) => {
        if (!appData.sessionMeta) appData.sessionMeta = {};
        appData.sessionMeta[sessionId] = { type: "chat", closed: false };
      });
      return { sessionId };
    },
    "session.send": async (input) => {
      const { sessionId, message } = input as { sessionId: string; message: string };
      await claudeService.send(sessionId, message);
      return { ok: true };
    },
    "session.permission": async (input) => {
      const { sessionId, requestId, allow } = input as { sessionId: string; requestId: string; allow: boolean };
      claudeService.resolvePermission(sessionId, requestId, allow);
      return { ok: true };
    },
    "session.interrupt": async (input) => {
      const { sessionId } = input as { sessionId: string };
      await claudeService.interrupt(sessionId);
      return { ok: true };
    },
    "session.close": async (input) => {
      const { sessionId } = input as { sessionId: string };
      claudeService.close(sessionId);
      await withAppData((appData) => {
        if (!appData.sessionMeta) appData.sessionMeta = {};
        const existing = appData.sessionMeta[sessionId];
        if (existing) {
          existing.closed = true;
        } else {
          appData.sessionMeta[sessionId] = { type: "chat", closed: true };
        }
      });
      return { ok: true };
    },

    // --- Automation ---
    "automation.list": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      const repoConfig = getRepoConfig(appData, repoPath);
      return repoConfig.automations ?? [];
    },
    "automation.save": async (input) => {
      const { repoPath, automation } = input as { repoPath: string; automation: any };
      await withAppData((appData) => {
        const repoConfig = getRepoConfig(appData, repoPath);
        if (!repoConfig.automations) repoConfig.automations = [];
        const idx = repoConfig.automations.findIndex((a: any) => a.id === automation.id);
        if (idx >= 0) {
          repoConfig.automations[idx] = automation;
        } else {
          repoConfig.automations.push(automation);
        }
        appData.repositoryConfigs[repoPath] = repoConfig;
      });
      return { ok: true };
    },
    "automation.delete": async (input) => {
      const { repoPath, automationId } = input as { repoPath: string; automationId: string };
      await withAppData((appData) => {
        const repoConfig = getRepoConfig(appData, repoPath);
        if (repoConfig.automations) {
          repoConfig.automations = repoConfig.automations.filter((a: any) => a.id !== automationId);
          appData.repositoryConfigs[repoPath] = repoConfig;
        }
      });
      return { ok: true };
    },
    "automation.listRuns": async (input) => {
      const { repoPath } = input as { repoPath?: string };
      const { listRuns } = await import("../cli/automation-registry.js");
      return listRuns(repoPath ? { repoPath } : undefined);
    },
    "automation.getRun": async (input) => {
      const { runId } = input as { runId: string };
      const { getRun } = await import("../cli/automation-registry.js");
      return getRun(runId);
    },
    "automation.cancelRun": async (input) => {
      const { runId } = input as { runId: string };
      const { cancelAutomationRun } = await import("../services/automation-service.js");
      await cancelAutomationRun(runId);
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Subscription handlers
// ---------------------------------------------------------------------------

export function createSubscriptionHandlers(opts: {
  terminalManager: TerminalManager;
  repoWatcher: RepoWatcher;
  claudeService: ClaudeService;
}): Partial<Record<SubscriptionProcedure, SubscriptionHandler>> {
  const { terminalManager, repoWatcher, claudeService } = opts;

  return {
    "worktree.updates": (input, push) => {
      const { repoPath } = input as { repoPath: string };

      // Send initial data
      getWorktrees(repoPath).then((wts) => push(wts)).catch(() => {});

      // Watch for changes — use lightweight FS reads instead of spawning git
      repoWatcher.watchRepo(repoPath).catch(() => {});
      const handler = async (changedRepo: string) => {
        if (changedRepo === repoPath) {
          try {
            const wts = await getWorktreesFromFS(repoPath);
            push(wts);
          } catch {}
        }
      };
      repoWatcher.on("changed", handler);
      return () => { repoWatcher.removeListener("changed", handler); };
    },

    "worktree.activityTimes": (input, push) => {
      const { repoPath } = input as { repoPath: string };
      let lastJson = "";
      const recompute = async () => {
        try {
          const wts = await getWorktreesFromFS(repoPath);
          const times = await computeWorktreeActivityTimes(repoPath, wts);
          const json = JSON.stringify(times);
          if (json !== lastJson) {
            lastJson = json;
            push(times);
          }
        } catch {}
      };
      // Initial push, then refresh on git changes (instant) and on a slow timer
      // (catches Claude session writes, which RepoWatcher doesn't observe).
      recompute();
      repoWatcher.watchRepo(repoPath).catch(() => {});
      const handler = (changedRepo: string) => { if (changedRepo === repoPath) recompute(); };
      repoWatcher.on("changed", handler);
      const interval = setInterval(recompute, 4000);
      return () => {
        clearInterval(interval);
        repoWatcher.removeListener("changed", handler);
      };
    },

    "fs.dirUpdates": (input, push) => {
      const { dirPath } = input as { dirPath: string };

      const readAndPush = async () => {
        try {
          push(await listDirEntries(dirPath));
        } catch {
          push([]);
        }
      };

      // Send initial listing, then re-read whenever the directory changes.
      readAndPush();

      let debounce: ReturnType<typeof setTimeout> | null = null;
      const onChange = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(readAndPush, 200);
      };

      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(dirPath, onChange);
        watcher.on("error", () => { /* ignore watch errors */ });
      } catch { /* dir may not exist — initial push already returned [] */ }

      return () => {
        if (debounce) clearTimeout(debounce);
        if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
      };
    },

    "fs.fileUpdates": (input, push) => {
      const { filePath } = input as { filePath: string };
      // Watch the parent directory and filter by filename: this survives the
      // atomic save (write-temp + rename) that many editors perform, which
      // would otherwise detach a watcher bound directly to the file.
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);

      const readAndPush = async () => {
        try {
          push(await readFileForEditor(filePath));
        } catch { /* file may have been removed; ignore */ }
      };

      // Send initial content, then re-read on change.
      readAndPush();

      let debounce: ReturnType<typeof setTimeout> | null = null;
      const onChange = (_event: string, changed: string | Buffer | null) => {
        if (changed && changed.toString() !== base) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(readAndPush, 150);
      };

      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(dir, onChange);
        watcher.on("error", () => { /* ignore watch errors */ });
      } catch { /* dir may not exist — initial push already returned content */ }

      return () => {
        if (debounce) clearTimeout(debounce);
        if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
      };
    },

    "terminal.events": (input, push) => {
      const { terminalId } = input as { terminalId: string };

      // Send buffered output if reconnecting
      const buffered = terminalManager.getBufferedOutput(terminalId);
      if (buffered) {
        push({ type: "buffered", data: buffered });
      }

      const dataListener = (data: string) => push({ type: "data", data });
      const exitListener = () => push({ type: "exit" });

      terminalManager.addDataListener(terminalId, dataListener);
      terminalManager.addExitListener(terminalId, exitListener);

      return () => {
        terminalManager.removeDataListener(terminalId, dataListener);
        terminalManager.removeExitListener(terminalId, exitListener);
      };
    },

    "stream.runInit": (input, push) => {
      const { worktreePath, initCommand } = input as { worktreePath: string; initCommand: string };
      const child = spawn(userShell, ["-li", "-c", initCommand], {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => push({ type: "stdout", text: chunk.toString() }));
      child.stderr.on("data", (chunk: Buffer) => push({ type: "stderr", text: chunk.toString() }));
      child.on("error", (err) => push({ type: "error", text: err.message }));
      child.on("close", (code) => push({ type: "done", success: code === 0, code: code ?? 1 }));
      return () => { if (!child.killed) child.kill(); };
    },

    "stream.createWorktree": (input, push) => {
      const inp = input as {
        repoPath: string; worktreeName: string; startingPoint?: string;
        poolPrefix?: string; pullLatest?: boolean;
      };
      const runCommand: RunCommand = (command, cwd) =>
        new Promise((resolve) => {
          const child = spawn(userShell, ["-li", "-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", (chunk: Buffer) => push({ type: "stdout", text: chunk.toString() }));
          child.stderr.on("data", (chunk: Buffer) => push({ type: "stderr", text: chunk.toString() }));
          child.on("error", (err) => { push({ type: "stderr", text: err.message }); resolve(1); });
          child.on("close", (code) => resolve(code ?? 1));
        });

      (async () => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, inp.repoPath);
        await createAndSetupWorktree(
          inp.repoPath,
          {
            worktreeName: inp.worktreeName,
            startingPoint: inp.startingPoint,
            poolPrefix: inp.poolPrefix,
            pullLatest: inp.pullLatest,
            mainBranch: repoConfig.mainBranch,
            worktreeDirectory: repoConfig.worktreeDirectory,
            initCommand: repoConfig.initCommand,
          },
          (event: StreamEvent) => push(event),
          runCommand,
        ).then((result) => {
          push({ type: "done", success: true, worktreePath: result.worktreePath, branch: result.branch });
        });
      })().catch((err: unknown) => {
        push({ type: "error", text: err instanceof Error ? err.message : String(err) });
        push({ type: "done", success: false });
      });

      // No child to kill here — the runCommand children are managed internally
    },

    "stream.launchTask": (input, push) => {
      const inp = input as {
        repoPath: string; poolType: string; poolPrefix: string; prompt: string;
        startingPoint?: string; maintenanceCommand?: string; taskCommand?: string;
      };
      const runCommand: RunCommand = (command, cwd) =>
        new Promise((resolve) => {
          const child = spawn(userShell, ["-li", "-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", (chunk: Buffer) => push({ type: "stdout", text: chunk.toString() }));
          child.stderr.on("data", (chunk: Buffer) => push({ type: "stderr", text: chunk.toString() }));
          child.on("error", (err) => { push({ type: "stderr", text: err.message }); resolve(1); });
          child.on("close", (code) => resolve(code ?? 1));
        });

      (async () => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, inp.repoPath);
        await launchTask(
          inp.repoPath,
          {
            poolType: inp.poolType as any,
            poolPrefix: inp.poolPrefix,
            prompt: inp.prompt,
            startingPoint: inp.startingPoint,
            maintenanceCommand: inp.maintenanceCommand,
            taskCommand: inp.taskCommand,
            mainBranch: repoConfig.mainBranch,
            worktreeDirectory: repoConfig.worktreeDirectory,
            initCommand: repoConfig.initCommand,
            launchedBy: "web",
          },
          (event: StreamEvent) => push(event),
          runCommand,
        ).then((result) => {
          push({ type: "done", success: true, worktreePath: result.worktreePath, taskId: result.taskRecord.id });
        });
      })().catch((err: unknown) => {
        push({ type: "error", text: err instanceof Error ? err.message : String(err) });
        push({ type: "done", success: false });
      });
    },

    "session.events": (input, push) => {
      const { sessionId } = input as { sessionId: string };
      return claudeService.subscribe(sessionId, (event) => push(event));
    },

    "session.list.updates": (input, push) => {
      // Initial data + broadcast on changes (placeholder — could be enhanced)
      const { dir } = input as { dir: string };
      // For now, just send initial. Real-time updates would need a watcher.
    },

    "stream.runAutomation": (input, push) => {
      const inp = input as {
        repoPath: string;
        automationId: string;
        worktreePath: string;
        prompt?: string;
      };

      const runCommand: RunCommand = (command, cwd) =>
        new Promise((resolve) => {
          const child = spawn(userShell, ["-li", "-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", (chunk: Buffer) => push({ type: "stdout", text: chunk.toString() }));
          child.stderr.on("data", (chunk: Buffer) => push({ type: "stderr", text: chunk.toString() }));
          child.on("error", (err) => { push({ type: "stderr", text: err.message }); resolve(1); });
          child.on("close", (code) => resolve(code ?? 1));
        });

      (async () => {
        const { runAutomation } = await import("../services/automation-service.js");
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, inp.repoPath);
        const automations = repoConfig.automations ?? [];
        const automation = automations.find((a: any) => a.id === inp.automationId);
        if (!automation) throw new Error(`Automation "${inp.automationId}" not found`);

        await runAutomation({
          repoPath: inp.repoPath,
          automation,
          repoConfig,
          worktreePath: inp.worktreePath,
          prompt: inp.prompt,
          onProgress: (event) => push(event),
          runCommand,
        });
      })().catch((err: unknown) => {
        push({ type: "error", text: err instanceof Error ? err.message : String(err) });
        push({ type: "done", success: false });
      });
    },
  };
}
