// Web server for Many - serves the frontend and tRPC API over HTTP
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { initTRPC } from "@trpc/server";
import * as gitPool from "../cli/git-pool.js";
import { loadAppData, saveAppData, getRepoConfig } from "../cli/config.js";
import type { AppData, RepositoryConfig } from "../cli/config.js";

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

// Simple terminal manager for web (without node-pty for now)
interface WebTerminalSession {
  id: string;
  workingDirectory: string;
  worktreePath?: string;
}

class WebTerminalManager {
  private sessions: Map<string, WebTerminalSession> = new Map();

  createSession(id: string, workingDirectory: string, worktreePath?: string): void {
    this.sessions.set(id, { id, workingDirectory, worktreePath });
  }

  getSession(id: string): WebTerminalSession | undefined {
    return this.sessions.get(id);
  }

  closeSession(id: string): void {
    this.sessions.delete(id);
  }

  sessionExists(id: string): boolean {
    return this.sessions.has(id);
  }

  getWorktreeTerminals(_worktreePath: string): { terminals: any[]; nextTerminalId: number } {
    return { terminals: [], nextTerminalId: 1 };
  }

  addTerminalToWorktree(_worktreePath: string, _terminal: any): void {}
  removeTerminalFromWorktree(_worktreePath: string, _terminalId: string): void {}
  cleanupWorktreeTerminals(_worktreePath: string): void {}
  createSetupTerminal(_worktreePath: string, _initCommand: string): void {}
}

// Create tRPC instance
const t = initTRPC.create();
const createCallerFactory = t.createCallerFactory;

// Create the router (simplified version for web)
const createRouter = (terminalManager: WebTerminalManager) => {
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
        return await gitPool.createWorktree(input.repoPath, input.branchName, repoConfig);
      }),

    archiveWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string; force?: boolean })
      .mutation(async ({ input }) => {
        const { simpleGit } = await import("simple-git");
        const git = simpleGit(input.repoPath);
        await git.raw(["worktree", "remove", "--force", input.worktreePath]);
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

    // External actions (limited in web version)
    openInFileManager: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async () => false),

    openInEditor: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async () => false),

    openInTerminal: t.procedure
      .input((input: unknown) => input as { folderPath: string })
      .mutation(async () => false),

    openDirectory: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async () => false),

    openTerminalInDirectory: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async () => false),

    openVSCode: t.procedure
      .input((input: unknown) => input as { dirPath: string })
      .mutation(async () => false),

    // Terminal management (limited in web version)
    getWorktreeTerminals: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .query(({ input }) => {
        return terminalManager.getWorktreeTerminals(input.worktreePath);
      }),

    addTerminalToWorktree: t.procedure
      .input((input: unknown) => input as { worktreePath: string; terminal: any })
      .mutation(({ input }) => {
        terminalManager.addTerminalToWorktree(input.worktreePath, input.terminal);
        return terminalManager.getWorktreeTerminals(input.worktreePath);
      }),

    removeTerminalFromWorktree: t.procedure
      .input((input: unknown) => input as { worktreePath: string; terminalId: string })
      .mutation(({ input }) => {
        terminalManager.removeTerminalFromWorktree(input.worktreePath, input.terminalId);
        return terminalManager.getWorktreeTerminals(input.worktreePath);
      }),

    createTerminalSession: t.procedure
      .input((input: unknown) => input as { terminalId: string; workingDirectory?: string; cols?: number; rows?: number; initialCommand?: string; worktreePath?: string })
      .mutation(({ input }) => {
        terminalManager.createSession(
          input.terminalId,
          input.workingDirectory || process.cwd(),
          input.worktreePath
        );
        return { success: true, message: "Terminal sessions not fully supported in web version" };
      }),

    sendTerminalData: t.procedure
      .input((input: unknown) => input as { terminalId: string; data: string })
      .mutation(() => ({ success: false, message: "Terminal not supported in web version" })),

    resizeTerminal: t.procedure
      .input((input: unknown) => input as { terminalId: string; cols: number; rows: number })
      .mutation(() => true),

    closeTerminal: t.procedure
      .input((input: unknown) => input as { terminalId: string })
      .mutation(({ input }) => {
        terminalManager.closeSession(input.terminalId);
        return true;
      }),

    terminalSessionExists: t.procedure
      .input((input: unknown) => input as { terminalId: string })
      .query(({ input }) => {
        return terminalManager.sessionExists(input.terminalId);
      }),

    cleanupWorktreeTerminals: t.procedure
      .input((input: unknown) => input as { worktreePath: string })
      .mutation(({ input }) => {
        terminalManager.cleanupWorktreeTerminals(input.worktreePath);
        return true;
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
        // Find the worktree by path
        const worktrees = await gitPool.getWorktrees(input.repoPath);
        const worktree = worktrees.find(w => w.path === input.worktreePath);
        if (!worktree) {
          throw new Error(`Worktree not found: ${input.worktreePath}`);
        }
        await gitPool.claimWorktree(input.repoPath, worktree, input.branchName, repoConfig);
        return { success: true };
      }),

    releaseWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreePath: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        // Find the worktree by path
        const worktrees = await gitPool.getWorktrees(input.repoPath);
        const worktree = worktrees.find(w => w.path === input.worktreePath);
        if (!worktree) {
          throw new Error(`Worktree not found: ${input.worktreePath}`);
        }
        const newBranch = await gitPool.releaseWorktree(input.repoPath, worktree, repoConfig);
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

    createPoolWorktree: t.procedure
      .input((input: unknown) => input as { repoPath: string; worktreeName: string })
      .mutation(async ({ input }) => {
        const appData = await loadAppData();
        const repoConfig = getRepoConfig(appData, input.repoPath);
        return await gitPool.createWorktree(input.repoPath, input.worktreeName, repoConfig);
      }),
  });
};

type AppRouter = ReturnType<typeof createRouter>;

// Handle tRPC request using caller factory
async function handleTrpcRequest(
  router: AppRouter,
  pathname: string,
  method: string,
  body: any
): Promise<{ status: number; body: any }> {
  const procedurePath = pathname.replace(/^\/trpc\//, "");

  try {
    // Create a caller to invoke procedures
    const callerFactory = createCallerFactory(router);
    const caller = callerFactory({});

    // Parse the input - could be in query string for GET or body for POST
    const input = body?.input;

    // Get the procedure from the router and invoke it
    const pathParts = procedurePath.split(".");
    let procedure: any = caller;
    for (const part of pathParts) {
      procedure = procedure[part];
    }

    if (typeof procedure !== "function") {
      return { status: 404, body: { error: `Procedure not found: ${procedurePath}` } };
    }

    const result = await procedure(input);
    return { status: 200, body: { result: { data: result } } };
  } catch (error: any) {
    console.error(`tRPC error for ${procedurePath}:`, error);
    return {
      status: 500,
      body: { error: { message: error.message || "Internal server error" } },
    };
  }
}

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
}

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const port = options.port || 3000;
  const host = options.host || "localhost";

  const terminalManager = new WebTerminalManager();
  const router = createRouter(terminalManager);

  // Determine static files directory
  const distDir = path.join(PROJECT_ROOT, "out", "renderer");

  // Check if built files exist
  try {
    await fs.access(path.join(distDir, "index.html"));
  } catch {
    console.error("Error: Built frontend not found. Please run 'npm run build' first.");
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      if (pathname.startsWith("/trpc/")) {
        let body: any = {};

        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const bodyStr = Buffer.concat(chunks).toString();
          if (bodyStr) {
            body = JSON.parse(bodyStr);
          }
        } else if (req.method === "GET") {
          const inputParam = url.searchParams.get("input");
          if (inputParam) {
            body = { input: JSON.parse(inputParam) };
          }
        }

        const result = await handleTrpcRequest(router, pathname, req.method || "GET", body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      let filePath = pathname === "/" ? "/index.html" : pathname;
      filePath = path.join(distDir, filePath);

      const result = await serveStaticFile(filePath);
      res.writeHead(result.status, { "Content-Type": result.contentType });
      res.end(result.body);
    } catch (error: any) {
      console.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    console.log("WebSocket client connected");

    ws.on("message", (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        console.log("WebSocket message:", data);
        ws.send(JSON.stringify({ type: "info", message: "Terminal not fully supported in web version" }));
      } catch (error) {
        console.error("WebSocket message error:", error);
      }
    });

    ws.on("close", () => {
      console.log("WebSocket client disconnected");
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`\nMany Web Server running at http://${host}:${port}`);
      console.log("\nNote: Terminal functionality is limited in the web version.");
      console.log("Press Ctrl+C to stop the server.\n");

      if (options.open) {
        const openUrl = `http://${host}:${port}`;
        const { exec } = require("child_process");
        const platform = process.platform;

        if (platform === "darwin") {
          exec(`open "${openUrl}"`);
        } else if (platform === "win32") {
          exec(`start "${openUrl}"`);
        } else {
          exec(`xdg-open "${openUrl}"`);
        }
      }

      resolve();
    });
  });
}
