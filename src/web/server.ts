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
import { reconcileTasks } from "../cli/task-registry.js";
import { TerminalManagerClient } from "../daemon/terminal-client.js";
import { RepoWatcher } from "./git-watcher.js";
import { RpcServer } from "./rpc-server.js";
import { createQueryHandlers, createSubscriptionHandlers } from "./rpc-handlers.js";
import { ClaudeService } from "../claude-session/server/claude-service.js";
import { SessionStore } from "../claude-session/server/session-store.js";
import { ClaudeUiService } from "./claude-ui/service.js";

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

// Terminal client - connects to (auto-spawning) the detached terminal daemon
// that actually owns the PTYs, so they survive this server process restarting.
const terminalManager = new TerminalManagerClient();

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
  /**
   * Register SIGINT/SIGTERM handlers that gracefully shut down the server
   * (and the daemon, only if no terminals are running). Default true. The CLI
   * and Electron set this false so they can prompt before killing terminals.
   */
  handleSignals?: boolean;
}

export interface WebServerResult {
  url: string;
  port: number;
  /** Number of live PTY sessions in the daemon (for shutdown prompts). */
  getRunningTerminalCount: () => Promise<number>;
  /**
   * Tear down watchers/RPC and disconnect from the daemon. The daemon (and its
   * PTYs) is only shut down if there are no running terminals, unless
   * killTerminals is set. Does not call process.exit.
   */
  shutdown: (opts?: { killTerminals?: boolean }) => Promise<void>;
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
  const claudeUiService = new ClaudeUiService();

  const rpcServer = new RpcServer({
    noServer: true,
    token,
    queryHandlers: createQueryHandlers({ terminalManager, claudeService, sessionStore, claudeUiService }),
    subscriptionHandlers: createSubscriptionHandlers({ terminalManager, repoWatcher, claudeService, claudeUiService }),
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

  // Graceful shutdown. PTYs live in the detached daemon now, so we do NOT kill
  // them here on a plain server restart. We only ask the daemon to shut down
  // (which saves logs + kills PTYs — see the daemon's shutdown path) when there
  // are no running terminals, or when the caller explicitly opts to kill them.
  let shuttingDown = false;
  const shutdown = async (opts?: { killTerminals?: boolean }): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    trackedPoller.stop();
    repoWatcher.close();
    claudeService.destroy();
    claudeUiService.destroy();
    rpcServer.destroy();
    try {
      const count = await terminalManager.getRunningCount();
      if (count === 0 || opts?.killTerminals) {
        await terminalManager.shutdownDaemon();
      }
    } catch (err) {
      logger.error("Failed to coordinate terminal daemon shutdown:", err);
    }
    terminalManager.disconnect();
  };

  if (options.handleSignals !== false) {
    const onSignal = async () => {
      await shutdown();
      process.exit(0);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

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

      resolve({
        url: serverUrl,
        port: actualPort,
        getRunningTerminalCount: () => terminalManager.getRunningCount(),
        shutdown,
      });
    });
  });
}
