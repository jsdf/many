#!/usr/bin/env -S npx tsx
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession, type PermissionMode } from "@libclaude/core";
import { WebSocketServerTransport } from "@libclaude/rpc/ws-server";
import { createRpcServer } from "./handlers.ts";

const HOST = process.env.LIBCLAUDE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? process.env.LIBCLAUDE_PORT ?? 4000);
const NO_AUTH = process.env.LIBCLAUDE_NO_AUTH === "true";
const TOKEN = process.env.LIBCLAUDE_TOKEN ?? crypto.randomBytes(24).toString("hex");

const session = new ClaudeSession({
  cwd: process.env.LIBCLAUDE_CWD ?? process.cwd(),
  model: process.env.LIBCLAUDE_MODEL || undefined,
  permissionMode: (process.env.LIBCLAUDE_PERMISSION_MODE as PermissionMode) || "auto",
  claudeBin: process.env.LIBCLAUDE_CLAUDE_BIN || undefined,
  extraArgs: process.env.LIBCLAUDE_ARGS ? process.env.LIBCLAUDE_ARGS.trim().split(/\s+/) : undefined,
});
session.on("error", (err) => console.error("[session]", err.message));

const rpc = createRpcServer(session);

// Serve the built web app in production; in dev, Vite serves it and proxies /ws.
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(thisDir, "../../web/dist");

const httpServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...session.status }));
    return;
  }
  serveStatic(req, res);
});

const transport = new WebSocketServerTransport({
  server: httpServer,
  path: "/ws",
  authenticate: NO_AUTH
    ? undefined
    : (url) => {
        const presented = url.searchParams.get("token") ?? "";
        const a = Buffer.from(presented);
        const b = Buffer.from(TOKEN);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      },
});
rpc.bind(transport);

httpServer.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.error(`[libclaude] listening on ${url}`);
  console.error(NO_AUTH ? "[libclaude] auth: DISABLED" : `[libclaude] token: ${TOKEN}`);
  // Machine-readable line for a launching orchestrator to parse.
  process.stdout.write(
    JSON.stringify({ event: "listening", url, wsUrl: `ws://${HOST}:${PORT}/ws`, token: NO_AUTH ? null : TOKEN }) + "\n",
  );
});

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("web app not built (run `npm run build`); in dev use the Vite server.");
    return;
  }
  const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
  let filePath = path.join(WEB_DIST, reqPath === "/" ? "index.html" : reqPath);
  if (!filePath.startsWith(WEB_DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_DIST, "index.html"); // SPA fallback
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function shutdown() {
  session.dispose();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
