// AutomationService - runs automation definitions on worktrees.

import { spawn } from "child_process";
import { promises as fs, createWriteStream } from "fs";
import path from "path";
import {
  createRun,
  updateRun,
  addWorkItems,
  updateWorkItem,
  getRun,
  type AutomationRun,
} from "../cli/automation-registry.js";
import { getTask, markTaskCompleted, updateTaskPid } from "../cli/task-registry.js";
import { getTaskLogDir } from "../cli/task-registry.js";
import { launchTask, releaseWorktreeByPath } from "./worktree-service.js";
import type { AutomationDefinition, RepositoryConfig } from "../cli/config.js";
import type { OnProgress, RunCommand } from "./types.js";

const userShell = process.env.SHELL || "/bin/bash";

export interface RunAutomationOptions {
  repoPath: string;
  automation: AutomationDefinition;
  repoConfig: RepositoryConfig;
  worktreePath: string;
  prompt?: string;
  onProgress?: OnProgress;
  runCommand?: RunCommand;
}

export async function runAutomation(
  options: RunAutomationOptions
): Promise<AutomationRun> {
  const { repoPath, automation, repoConfig, worktreePath, onProgress } = options;

  const pool = repoConfig.pools?.find((p) => p.taskCommand || p.backgroundTaskCommand);
  if (!pool) {
    throw new Error("No task pool configured");
  }
  const taskCommand = pool.backgroundTaskCommand || pool.taskCommand;
  if (!taskCommand) {
    throw new Error("No task command configured");
  }

  let prompt: string;
  if (automation.type === "skill") {
    prompt = `/${automation.skillName}`;
    if (options.prompt) prompt += ` ${options.prompt}`;
  } else {
    prompt = automation.prompt ?? "";
    if (options.prompt) prompt += `\n\n${options.prompt}`;
  }

  const run = await createRun({
    automationId: automation.id,
    automationName: automation.name,
    repoPath,
    status: "running",
  });

  onProgress?.({ type: "step", text: `Running automation: ${automation.name}` });

  try {
    await addWorkItems(run.id, [prompt]);
    const currentRun = await getRun(run.id);
    const workItem = currentRun?.workItems[0];
    if (!workItem) throw new Error("Failed to create work item");

    const logDir = repoConfig.terminalLogDir || getTaskLogDir();
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${run.id}-task.log`);

    const result = await launchTask(
      repoPath,
      {
        poolType: pool.type,
        poolPrefix: pool.prefix,
        prompt,
        maintenanceCommand: pool.maintenanceCommand,
        initCommand: repoConfig.initCommand,
        mainBranch: repoConfig.mainBranch,
        worktreeDirectory: repoConfig.worktreeDirectory,
        taskCommand,
        launchedBy: "web",
        logFile,
      },
      onProgress,
      options.runCommand
    );

    await updateWorkItem(run.id, workItem.id, {
      status: "running",
      taskId: result.taskRecord.id,
      worktreePath: result.worktreePath,
    });

    const exitCode = await spawnTaskProcess(
      taskCommand,
      result.worktreePath,
      prompt,
      logFile,
      result.taskRecord.id,
      onProgress
    );

    const finalStatus = exitCode === 0 ? "completed" : "failed";
    await updateWorkItem(run.id, workItem.id, { status: finalStatus as any });
    await updateRun(run.id, { status: finalStatus as any });

    onProgress?.({
      type: "step",
      text: `Automation ${finalStatus}: ${automation.name}`,
    });

    return (await getRun(run.id))!;
  } catch (err: any) {
    onProgress?.({ type: "error", text: `Automation failed: ${err.message}` });
    await updateRun(run.id, { status: "failed" });
    return (await getRun(run.id))!;
  }
}

function spawnTaskProcess(
  taskCommand: string,
  cwd: string,
  prompt: string,
  logFile: string,
  taskId: string,
  onProgress?: OnProgress
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(userShell, ["-li", "-c", taskCommand], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MANY_TASK_PROMPT: prompt,
      },
    });

    updateTaskPid(taskId, child.pid ?? 0).catch(() => {});

    const logStream = createWriteStream(logFile, { flags: "a" });
    child.stdout.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      if (onProgress) {
        onProgress({ type: "stdout", text: chunk.toString() });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
      if (onProgress) {
        onProgress({ type: "stderr", text: chunk.toString() });
      }
    });

    child.on("error", (error) => {
      logStream.end();
      onProgress?.({ type: "error", text: error.message });
      markTaskCompleted(taskId, 1).catch(() => {});
      resolve(1);
    });

    child.on("close", (code) => {
      logStream.end();
      const exitCode = code ?? 1;
      markTaskCompleted(taskId, exitCode).catch(() => {});
      resolve(exitCode);
    });
  });
}

export async function cancelAutomationRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run || run.status !== "running") return;

  await updateRun(runId, { status: "cancelled" });

  const { killTask } = await import("../cli/task-registry.js");
  for (const item of run.workItems) {
    if (item.status === "running" && item.taskId) {
      await killTask(item.taskId).catch(() => {});
      await updateWorkItem(runId, item.id, { status: "failed" });
    }
  }
}
