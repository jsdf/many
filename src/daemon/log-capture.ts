/**
 * Capture a terminal's buffered output to a read-only log file and register a
 * completed task record for it. This runs when a PTY actually dies — either a
 * natural exit or the daemon being shut down — NOT on every server restart
 * (the PTYs now outlive the server). Ported from the old server cleanup path.
 */

import path from "path";
import { promises as fs } from "fs";
import logger from "../shared/logger.js";
import { loadAppData } from "../cli/config.js";
import { getTaskLogDir, registerTask, markTaskCompleted } from "../cli/task-registry.js";

/**
 * Write `output` to a task-log file and register a completed "Terminal session"
 * task pointing at it. No-op when there is no output. Best-effort: failures are
 * logged, not thrown, so they can't block daemon shutdown.
 */
export async function saveAndRegisterTerminalLog(
  terminalId: string,
  worktreePath: string,
  output: string
): Promise<void> {
  if (!output) return;
  try {
    const logDir = getTaskLogDir();
    await fs.mkdir(logDir, { recursive: true });

    const label = path.basename(worktreePath).replace(/[/\\:*?"<>|]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(logDir, `terminal-${label}-${timestamp}.log`);
    await fs.writeFile(logFile, output);

    const appData = await loadAppData();
    let repoPath = "";
    for (const [rp, cfg] of Object.entries(appData.repositoryConfigs)) {
      const worktreeDir = (cfg as any).worktreeDirectory || path.dirname(rp);
      if (worktreePath === rp || worktreePath.startsWith(worktreeDir + path.sep)) {
        repoPath = rp;
        break;
      }
    }

    let branch = "";
    try {
      const { simpleGit } = await import("simple-git");
      const status = await simpleGit(worktreePath).status();
      branch = status.current || "";
    } catch {
      // worktree may be gone; leave branch empty
    }

    const task = await registerTask({
      pid: 0,
      repoPath,
      worktreePath,
      poolPrefix: "",
      poolName: "",
      branch,
      prompt: "Terminal session (saved on exit)",
      taskCommand: "",
      logFile,
      launchedBy: "web",
    });
    await markTaskCompleted(task.id, 0);
  } catch (err) {
    logger.error(`[terminal-daemon] failed to save terminal log for ${terminalId}:`, err);
  }
}
