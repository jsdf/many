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
import { loadAppData, saveAppData, getRepoConfig, getGlobalSettings } from "../cli/config.js";
import {
  checkBranchMerged,
  removeWorktree,
  getErrorMessage,
  parseWorktreeList,
} from "../shared/git-core.js";
import { TerminalManager } from "./terminal-manager.js";

const execAsync = promisify(exec);

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
      .input((input: unknown) => input as { repoPath: string; worktreePath: string })
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

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const port = options.port ?? 0;
  const host = options.host || "localhost";
  const token = options.token || crypto.randomBytes(24).toString("hex");

  const router = createRouter();

  // Determine static files directory
  const distDir = path.join(PROJECT_ROOT, "out", "renderer");

  // Check if built files exist
  try {
    await fs.access(path.join(distDir, "index.html"));
  } catch {
    console.error("Error: Built frontend not found. Please run 'npm run build' first.");
    process.exit(1);
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

      // Static files (HTML, JS, CSS, images) served without token.
      // The token in the URL is read by the JS client for API auth.
      let filePath = pathname === "/" ? path.join(distDir, "index.html") : path.join(distDir, pathname);
      const result = await serveStaticFile(filePath);
      res.writeHead(result.status, { "Content-Type": result.contentType });
      res.end(result.body);
    } catch (error) {
      console.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

  // WebSocket server for terminal sessions
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    // Only handle terminal WebSocket connections
    if (url.pathname !== "/ws/terminal") {
      socket.destroy();
      return;
    }

    // Auth check
    const queryToken = url.searchParams.get("token");
    if (queryToken !== token) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
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

    ws.on("message", (rawMsg) => {
      let msg: any;
      try {
        msg = JSON.parse(rawMsg.toString());
      } catch {
        return;
      }

      const { type, terminalId } = msg;

      switch (type) {
        case "create": {
          const { worktreePath, cols, rows } = msg;
          const existed = terminalManager.createSession(terminalId, worktreePath, cols || 80, rows || 24);

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

  // Cleanup on server shutdown
  const cleanupAndExit = () => {
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

      resolve();
    });
  });
}
