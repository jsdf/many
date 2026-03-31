import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";
import path from "path";
import { spawn, execSync, type ChildProcess } from "child_process";
import { createServer as createNetServer } from "net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const port = (srv.address() as import("net").AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Vite plugin that builds and starts the claude-session backend on a free port,
 * then proxies WebSocket requests to it.
 */
function claudeSessionBackend(): Plugin {
  let backendProcess: ChildProcess | null = null;

  return {
    name: "claude-session-backend",
    apply: "serve",
    async config() {
      // Build the server
      console.log("[claude-session] Building server...");
      execSync("npx tsc -p tsconfig.cli.json", {
        cwd: __dirname,
        stdio: "inherit",
      });

      const port = await getFreePort();

      backendProcess = spawn(
        "node",
        ["dist-cli/claude-session/server/index.js", process.cwd()],
        {
          cwd: __dirname,
          env: {
            ...process.env,
            PORT: String(port),
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      backendProcess.stdout!.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
      });
      backendProcess.stderr!.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      return {
        server: {
          proxy: {
            "/ws": {
              target: `ws://localhost:${port}`,
              ws: true,
            },
          },
        },
      };
    },
    buildEnd() {
      if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
      }
    },
  };
}

export default defineConfig({
  root: "src/claude-session/renderer",
  plugins: [react(), tailwindcss(), claudeSessionBackend()],
  server: {
    open: `/?token=dev&cwd=${encodeURIComponent(process.cwd())}`,
  },
  build: {
    outDir: resolve("out/claude-session"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve("src/claude-session/renderer/index.html"),
      },
    },
  },
});
