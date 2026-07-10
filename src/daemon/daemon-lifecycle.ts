/**
 * Helpers for locating, detecting, spawning, and shutting down the terminal
 * daemon. The daemon owns all PTYs and outlives the web server / Electron app;
 * these helpers are used by the client (to connect / auto-spawn) and by the
 * daemon itself (to publish its info file).
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { getDataPath } from "../cli/config.js";
import { isProcessAlive } from "../cli/task-registry.js";
import logger from "../shared/logger.js";
import { DAEMON_PROTOCOL_VERSION } from "./terminal-daemon-protocol.js";

export interface DaemonInfo {
  pid: number;
  socketPath: string;
  version: number;
  startedAt: string;
}

/** Path of the IPC endpoint: a Windows named pipe, or a Unix socket file. */
export function getSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\many-terminal-daemon";
  }
  return path.join(getDataPath(), "terminal-daemon.sock");
}

/** Path of the daemon info/PID file. */
export function getInfoPath(): string {
  return path.join(getDataPath(), "terminal-daemon.json");
}

/** Absolute path of the compiled daemon entry point (sibling of this module). */
function getDaemonEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "terminal-daemon.js");
}

/** Read and parse the daemon info file, or null if absent/unreadable. */
export async function readDaemonInfo(): Promise<DaemonInfo | null> {
  try {
    const raw = await fs.readFile(getInfoPath(), "utf8");
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Atomically write the daemon info file (temp + rename). Called by the daemon. */
export async function writeDaemonInfo(info: DaemonInfo): Promise<void> {
  await fs.mkdir(getDataPath(), { recursive: true });
  const target = getInfoPath();
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(info, null, 2));
  await fs.rename(tmp, target);
}

/** Remove the daemon info file (best-effort). Called by the daemon on exit. */
export async function removeDaemonInfo(): Promise<void> {
  try {
    await fs.unlink(getInfoPath());
  } catch {
    // already gone
  }
}

/**
 * Return the info of a running daemon, or null. A daemon is considered running
 * only if its info file exists AND its recorded pid is alive.
 */
export async function isDaemonRunning(): Promise<DaemonInfo | null> {
  const info = await readDaemonInfo();
  if (!info) return null;
  if (!isProcessAlive(info.pid)) return null;
  return info;
}

/**
 * Spawn the daemon detached so it survives this process exiting. Resolves once
 * the daemon's socket is accepting connections (or rejects on timeout).
 */
export async function spawnDaemon(timeoutMs = 5000): Promise<DaemonInfo> {
  const entry = getDaemonEntryPath();
  // process.execPath is `node` for the CLI and the Electron binary for the app;
  // ELECTRON_RUN_AS_NODE makes the latter behave as a plain Node runtime.
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();

  const start = Date.now();
  const socketPath = getSocketPath();
  while (Date.now() - start < timeoutMs) {
    const info = await isDaemonRunning();
    if (info && (await canConnect(socketPath))) {
      return info;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for terminal daemon to start");
}

/** Resolve a running daemon, spawning one if none is alive. */
export async function ensureDaemon(): Promise<DaemonInfo> {
  const existing = await isDaemonRunning();
  if (existing && (await canConnect(existing.socketPath))) {
    // A daemon from an older build speaks a different wire protocol: it would
    // silently ignore ops it doesn't know (leaving the client hanging). The
    // daemon is designed to outlive the app, so an old one can still be running
    // after an upgrade. Replace it with a fresh daemon on version mismatch.
    if (existing.version === DAEMON_PROTOCOL_VERSION) return existing;
    logger.info(
      `[terminal-daemon] replacing daemon (pid ${existing.pid}) with protocol v${existing.version}; this build speaks v${DAEMON_PROTOCOL_VERSION}`
    );
    await killDaemon(existing);
  }
  return spawnDaemon();
}

/** SIGTERM a daemon and wait for it to exit (SIGKILL as a fallback). */
async function killDaemon(info: DaemonInfo, timeoutMs = 3000): Promise<void> {
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(info.pid)) break;
    await delay(100);
  }
  if (isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await removeDaemonInfo();
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The protocol version this build speaks. */
export { DAEMON_PROTOCOL_VERSION };

export function logDaemon(msg: string): void {
  logger.info(`[terminal-daemon] ${msg}`);
}
