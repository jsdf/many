/**
 * Claude session server — separate entry point from the main many server.
 * Serves the claude-session renderer and provides the WebSocket RPC API.
 */

import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { ClaudeService } from "./claude-service.js";
import { SessionStore } from "./session-store.js";
import { ClaudeSessionRpc } from "./rpc.js";

export interface ClaudeSessionServerOptions {
  /** Port to listen on (0 for random) */
  port?: number;
  /** Directory for session context (worktree path) */
  cwd?: string;
}

export async function startClaudeSessionServer(
  opts: ClaudeSessionServerOptions = {}
) {
  const port = opts.port ?? 0;
  const token = crypto.randomBytes(24).toString("hex");

  const claudeService = new ClaudeService();
  const sessionStore = new SessionStore();

  // Static file serving for the renderer build
  // Built server lives at dist-cli/claude-session/server/index.js
  // Renderer output lives at out/claude-session/
  const distDir = path.resolve(
    import.meta.dirname ?? __dirname,
    "../../../out/claude-session"
  );

  const server = http.createServer((req, res) => {
    // Token check for API routes
    const url = new URL(req.url ?? "", `http://localhost:${port}`);

    // Serve static files
    let filePath = path.join(distDir, url.pathname === "/" ? "index.html" : url.pathname);

    // SPA fallback
    if (!fs.existsSync(filePath)) {
      filePath = path.join(distDir, "index.html");
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[ext] ?? "application/octet-stream",
    });
    fs.createReadStream(filePath).pipe(res);
  });

  // WebSocket RPC
  const rpc = new ClaudeSessionRpc({
    server,
    path: "/ws",
    token,
    claudeService,
    sessionStore,
  });

  return new Promise<{
    url: string;
    token: string;
    port: number;
    close: () => void;
  }>((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" ? addr!.port : port;
      const url = `http://localhost:${actualPort}?token=${token}`;

      console.log(`[claude-session] Server running at ${url}`);

      if (opts.cwd) {
        console.log(`[claude-session] Working directory: ${opts.cwd}`);
      }

      resolve({
        url,
        token,
        port: actualPort,
        close: () => {
          claudeService.destroy();
          rpc.destroy();
          server.close();
        },
      });
    });
  });
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("claude-session/server/index.js") ||
    process.argv[1].endsWith("claude-session/server/index.ts"))
) {
  const port = parseInt(process.env.PORT ?? "0", 10);
  const cwd = process.argv[2] ?? process.cwd();

  startClaudeSessionServer({ port, cwd }).catch((err) => {
    console.error("Failed to start claude-session server:", err);
    process.exit(1);
  });
}
