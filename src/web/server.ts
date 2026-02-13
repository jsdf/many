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
import * as gitPool from "../cli/git-pool.js";
import { loadAppData, saveAppData, getRepoConfig, getGlobalSettings } from "../cli/config.js";
import {
  checkBranchMerged,
  removeWorktree,
  getErrorMessage,
  parseWorktreeList,
} from "../shared/git-core.js";

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
        return await gitPool.createWorktree(input.repoPath, input.branchName, repoConfig);
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

      // Static files (HTML, JS, CSS, images) served without token.
      // The token in the URL is read by the JS client for API auth.
      let filePath = pathname === "/" ? path.join(distDir, "index.html") : path.join(distDir, pathname);
      const result = await serveStaticFile(filePath);
      res.writeHead(result.status, { "Content-Type": result.contentType });
      res.end(result.body);
    } catch (error: any) {
      console.error("Server error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });

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
