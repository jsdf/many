/**
 * RPC query and subscription handlers.
 * Each handler delegates to the existing service layer — no business logic here.
 */

import path from "path";
import { promises as fs } from "fs";
import { spawn, execSync } from "child_process";
import logger from "../shared/logger.js";
import type { QueryHandler, SubscriptionHandler } from "./rpc-server.js";
import type { QueryProcedure, SubscriptionProcedure, StreamEvent } from "../shared/protocol.js";
import { loadAppData, saveAppData, getRepoConfig, getGlobalSettings } from "../cli/config.js";
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
      const { worktreePath } = input as { worktreePath: string };
      await amendChanges(worktreePath);
      return { ok: true };
    },
    "worktree.commit": async (input) => {
      const { worktreePath, message } = input as { worktreePath: string; message: string };
      await commitChanges(worktreePath, message);
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

    // --- Repository ---
    "repo.list": async () => {
      const appData = await loadAppData();
      return appData.repositories;
    },
    "repo.add": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      if (!appData.repositories.some((r: any) => r.path === repoPath)) {
        appData.repositories.push({ path: repoPath, name: path.basename(repoPath), addedAt: new Date().toISOString() });
        await saveAppData(appData);
      }
      return { ok: true };
    },
    "repo.getSelected": async () => {
      const appData = await loadAppData();
      return appData.selectedRepo;
    },
    "repo.setSelected": async (input) => {
      const { repoPath } = input as { repoPath: string | null };
      const appData = await loadAppData();
      appData.selectedRepo = repoPath;
      await saveAppData(appData);
      return { ok: true };
    },
    "repo.getConfig": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return getRepoConfig(appData, repoPath);
    },
    "repo.saveConfig": async (input) => {
      const { repoPath, config } = input as { repoPath: string; config: any };
      const appData = await loadAppData();
      appData.repositoryConfigs[repoPath] = config;
      await saveAppData(appData);
      return { ok: true };
    },
    "repo.recentWorktree": async (input) => {
      const { repoPath } = input as { repoPath: string };
      const appData = await loadAppData();
      return appData.recentWorktrees[repoPath] || null;
    },
    "repo.setRecentWorktree": async (input) => {
      const { repoPath, worktreePath } = input as { repoPath: string; worktreePath: string };
      const appData = await loadAppData();
      appData.recentWorktrees[repoPath] = worktreePath;
      await saveAppData(appData);
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

    // --- Settings ---
    "settings.get": async () => {
      const appData = await loadAppData();
      return getGlobalSettings(appData);
    },
    "settings.save": async (input) => {
      const appData = await loadAppData();
      appData.globalSettings = input as any;
      await saveAppData(appData);
      return { ok: true };
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
      return getClaudeSessions(worktreePath);
    },
    "claude.sessionMessages": async (input) => {
      const { sessionId, worktreePath, offset, limit } = input as any;
      return getSessionMessages(sessionId, worktreePath, offset, limit);
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
      const child = spawn(initCommand, {
        shell: true,
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
          const child = spawn(command, { shell: userShell, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
          const child = spawn(command, { shell: userShell, cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  };
}
