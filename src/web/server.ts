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
} from "../cli/task-registry.js";
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

// Build a RunCommand that pipes stdout/stderr to SSE and kills the child when the request closes.
function makeSseRunCommand(
  sendEvent: (data: object) => void,
  req: http.IncomingMessage
): RunCommand {
  return (command, cwd) =>
    new Promise((resolve) => {
      const child = spawn(command, {
        shell: userShell,
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
}

// Create the router
const createRouter = () => {
  return t.router({
    // Git operations
    getWorktrees: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => getWorktrees(input.repoPath)),

    getBranches: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => getBranches(input.repoPath)),

    getGitUsername: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => getGitUsername(input.repoPath)),

    createWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; branchName: string; baseBranch: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const result = await createWorktree(input.repoPath, input.branchName, repoConfig);
        return { ...result, initCommand: repoConfig.initCommand };
      }),

    archiveWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; force?: boolean })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);

        // Kill any terminal sessions for this worktree
        terminalManager.cleanupWorktree(input.worktreePath);

        await serviceArchiveWorktree(input.repoPath, input.worktreePath, {
          force: input.force,
          mainBranch: repoConfig.mainBranch,
        });
        return true;
      }),

    checkBranchMerged: t.procedure
      .input((input: unknown) => input as { repoPath: string; branchName: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        return checkBranchMergedByName(input.repoPath, input.branchName, repoConfig.mainBranch);
      }),

    mergeWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; fromBranch: string; toBranch: string; options: any })
      .mutation(async ({ input }) => {
        await mergeWorktree(input.repoPath, input.fromBranch, input.toBranch, input.options);
        return true;
      }),

    rebaseWorktree: t.procedure
      .input((input: unknown) => input as { worktreePath: string; fromBranch: string; ontoBranch: string })
      .mutation(async ({ input }) => {
        await rebaseWorktree(input.worktreePath, input.fromBranch, input.ontoBranch);
        return true;
      }),

    getWorktreeStatus: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .query(async ({ input }) => getWorktreeStatus(input.worktreePath)),

    getCommitLog: t.procedure
      .input((input: unknown) => input as { worktreePath: string; baseBranch: string })
      .query(async ({ input }) => getCommitLog(input.worktreePath, input.baseBranch)),

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
      .query(async ({ input }) => getGitHubLink(input.repoPath, input.branch)),

    // Pool management operations
    isTmpBranch: t.procedure
      .input((input: unknown) => input as { branchName: string | null })
      .query(({ input }) => isTmpBranch(input.branchName)),

    getDefaultBranch: t.procedure
      .input((input: unknown) => input as { repoPath: string })
      .query(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        return getDefaultBranchForConfig(input.repoPath, repoConfig);
      }),

    claimWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; branchName: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        await claimWorktreeByPath(input.repoPath, input.worktreePath, input.branchName, repoConfig.mainBranch);
        return { success: true };
      }),

    releaseWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; force?: boolean })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        terminalManager.cleanupWorktree(input.worktreePath);
        const newBranch = await releaseWorktreeByPath(input.repoPath, input.worktreePath, repoConfig.mainBranch, input.force ?? false);
        return { success: true, branch: newBranch };
      }),

    stashWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string; message?: string })
      .mutation(async ({ input }) => {
        await stashChanges(input.worktreePath, input.message);
        return true;
      }),

    cleanWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .mutation(async ({ input }) => {
        await cleanChanges(input.worktreePath);
        return true;
      }),

    amendWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .mutation(async ({ input }) => {
        await amendChanges(input.worktreePath);
        return true;
      }),

    commitWorktreeChanges: t.procedure
      .input((input: unknown) => input as { worktreePath: string; message: string })
      .mutation(async ({ input }) => {
        await commitChanges(input.worktreePath, input.message);
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
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        return getBranchDiff(input.worktreePath, input.repoPath, repoConfig.mainBranch);
      }),

    createPoolWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreeName: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        const result = await createWorktree(input.repoPath, input.worktreeName, repoConfig);
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
        const branchName = await resolveStartingPoint(input.repoPath, input.startingPoint);
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

        const runCommand = makeSseRunCommand(sendEvent, req);

        try {
          const appData = await loadAppData();
          const repoConfig = getRepoConfig(appData, parsed.repoPath);

          const result = await createAndSetupWorktree(
            parsed.repoPath,
            {
              worktreeName: parsed.worktreeName,
              startingPoint: parsed.startingPoint,
              poolPrefix: parsed.poolPrefix,
              pullLatest: parsed.pullLatest,
              initCommand: repoConfig.initCommand,
              mainBranch: repoConfig.mainBranch,
              worktreeDirectory: repoConfig.worktreeDirectory,
            },
            sendEvent,
            runCommand
          );

          sendEvent({ type: "done", success: true, worktreePath: result.worktreePath, branch: result.branch });
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

        const runCommand = makeSseRunCommand(sendEvent, req);

        try {
          const appData = await loadAppData();
          const repoConfig = getRepoConfig(appData, parsed.repoPath);

          const result = await launchTask(
            parsed.repoPath,
            {
              poolType: parsed.poolType,
              poolPrefix: parsed.poolPrefix,
              prompt: parsed.prompt,
              startingPoint: parsed.startingPoint,
              maintenanceCommand: parsed.maintenanceCommand,
              initCommand: repoConfig.initCommand,
              mainBranch: repoConfig.mainBranch,
              worktreeDirectory: repoConfig.worktreeDirectory,
              taskCommand: parsed.taskCommand,
              launchedBy: "web",
            },
            sendEvent,
            runCommand
          );

          sendEvent({ type: "done", success: true, worktreePath: result.worktreePath, taskId: result.taskRecord.id });
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
          const { worktreePath, cols, rows, env, initialCommand, taskId, isDark } = msg;
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
          // Signal dark/light mode to CLI tools via COLORFGBG
          const colorEnv: Record<string, string> = {};
          if (isDark) {
            colorEnv.COLORFGBG = "15;0"; // white on black
          } else {
            colorEnv.COLORFGBG = "0;15"; // black on white
          }
          const mergedEnv = { ...colorEnv, ...env };
          const existed = terminalManager.createSession(terminalId, worktreePath, cols || 80, rows || 24, mergedEnv, initialCommand, terminalLogDir);

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
