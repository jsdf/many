// Web server for Many - serves the frontend and provides WebSocket RPC API
import http from "http";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import crypto from "crypto";
import type { AddressInfo } from "net";

import logger from "../shared/logger.js";
import { loadAppData } from "../cli/config.js";
import { startTrackedPoller } from "./tracked-poller.js";
import {
  registerTask,
  markTaskCompleted,
  reconcileTasks,
} from "../cli/task-registry.js";
import { TerminalManager } from "./terminal-manager.js";
import { RepoWatcher } from "./git-watcher.js";
import { RpcServer } from "./rpc-server.js";
import { createQueryHandlers, createSubscriptionHandlers } from "./rpc-handlers.js";
import { ClaudeService } from "../claude-session/server/claude-service.js";
import { SessionStore } from "../claude-session/server/session-store.js";

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

// Terminal manager - singleton, lives for the server's lifetime
const terminalManager = new TerminalManager();

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
    logger.info("Built frontend not found. Assuming dev mode (Vite serves frontend).");
  }

  // --- HTTP server: static files only ---
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
      // Serve static files (frontend)
      if (hasStaticFiles) {
        let filePath = path.join(distDir, pathname === "/" ? "index.html" : pathname);

        const result = await serveStaticFile(filePath);
        if (result.status === 404 && !pathname.includes(".")) {
          // SPA fallback for client-side routing
          const fallback = await serveStaticFile(path.join(distDir, "index.html"));
          res.writeHead(fallback.status, { "Content-Type": fallback.contentType });
          res.end(fallback.body);
        } else {
          res.writeHead(result.status, { "Content-Type": result.contentType });
          res.end(result.body);
        }
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Not found (frontend not built, use Vite dev server)");
      }
    } catch (error) {
      logger.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

  // --- Unified mux-style WebSocket RPC ---
  const claudeService = new ClaudeService();
  const sessionStore = new SessionStore();
  const repoWatcher = new RepoWatcher();

  const rpcServer = new RpcServer({
    noServer: true,
    token,
    queryHandlers: createQueryHandlers({ terminalManager, claudeService, sessionStore }),
    subscriptionHandlers: createSubscriptionHandlers({ terminalManager, repoWatcher, claudeService }),
  });

  // Start watching all known repos
  const appDataForWatch = await loadAppData();
  for (const repo of appDataForWatch.repositories) {
    repoWatcher.watchRepo(repo.path).catch(() => {});
  }

  // Poll GitHub for assigned PRs and auto-track their branches
  const trackedPoller = startTrackedPoller();

  // WebSocket upgrade — single path
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);

    // Auth check
    const queryToken = url.searchParams.get("token");
    if (queryToken !== token) {
      socket.destroy();
      return;
    }

    if (url.pathname === "/ws") {
      rpcServer.handleUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // Cleanup on server shutdown — save terminal logs before exiting
  const cleanupAndExit = async () => {
    trackedPoller.stop();
    repoWatcher.close();
    claudeService.destroy();
    rpcServer.destroy();

    // Save terminal output as read-only logs
    try {
      const { getTaskLogDir } = await import("../cli/task-registry.js");
      const logDir = getTaskLogDir();
      const saved = await terminalManager.saveAllSessionLogs(logDir);

      if (saved.length > 0) {
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
      logger.error("Failed to save terminal logs on shutdown:", err);
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

      logger.info(`Many Web Server running at ${serverUrl}`);
      console.log(`\nMany Web Server running at ${serverUrl}`);
      console.log("Press Ctrl+C to stop the server.\n");
      console.log(`Log file: ${logger.getLogFilePath()}\n`);

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
