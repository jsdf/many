// Web server for Many - serves the frontend and provides WebSocket RPC API
import http from "http";
import { promises as fs, createReadStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import crypto from "crypto";
import type { AddressInfo } from "net";

import logger from "../shared/logger.js";
import { loadAppData } from "../cli/config.js";
import { startTrackedPoller } from "./tracked-poller.js";
import { startAutomationScheduler } from "./automation-scheduler.js";
import { reconcileTasks } from "../cli/task-registry.js";
import { reconcileAutomationRuns } from "../cli/automation-registry.js";
import { TerminalManagerClient } from "../daemon/terminal-client.js";
import { RepoWatcher, WorkdirWatcher } from "./git-watcher.js";
import { RpcServer } from "./rpc-server.js";
import { createQueryHandlers, createSubscriptionHandlers } from "./rpc-handlers.js";
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
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
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

// Stream a local file by absolute path with the correct MIME type, honoring
// HTTP Range requests so media elements (video/audio) can seek. Used by the
// /api/file endpoint to render images, video and audio from the file tree.
async function serveLocalFile(filePath: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  createReadStream(filePath).pipe(res);
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
  // Mark any automation runs left "running" from a previous process as failed —
  // the scheduler is in-process, so a run can't survive a server restart.
  await reconcileAutomationRuns();

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
      // Serve an arbitrary local file (media in the file tree). Token-guarded,
      // same as the WebSocket RPC which can already read any file.
      if (pathname === "/api/file") {
        if (url.searchParams.get("token") !== token) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        const reqPath = url.searchParams.get("path");
        if (!reqPath) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing path");
          return;
        }
        await serveLocalFile(reqPath, req, res);
        return;
      }

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
  const repoWatcher = new RepoWatcher();
  const worktreeWatcher = new WorkdirWatcher();
  const claudeUiService = new ClaudeUiService(terminalManager);

  const rpcServer = new RpcServer({
    noServer: true,
    token,
    queryHandlers: createQueryHandlers({ terminalManager, claudeUiService }),
    subscriptionHandlers: createSubscriptionHandlers({ terminalManager, repoWatcher, worktreeWatcher, claudeUiService }),
  });

  // Start watching all known repos
  const appDataForWatch = await loadAppData();
  for (const repo of appDataForWatch.repositories) {
    repoWatcher.watchRepo(repo.path).catch(() => {});
  }

  // Poll GitHub for assigned PRs and auto-track their branches
  const trackedPoller = startTrackedPoller();

  // Fire cron-scheduled automations while this server process runs
  const automationScheduler = startAutomationScheduler();

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
    automationScheduler.stop();
    repoWatcher.close();
    worktreeWatcher.close();
    rpcServer.destroy();
    try {
      // Claude UI sessions now live in the daemon, same as terminals and
      // `many agent` sessions, so they count toward whether it's safe to
      // shut the daemon down.
      const count = (await terminalManager.getRunningCount()) + (await claudeUiService.getRunningCount());
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
        getRunningTerminalCount: async () =>
          (await terminalManager.getRunningCount()) + (await claudeUiService.getRunningCount()),
        shutdown,
      });
    });
  });
}
