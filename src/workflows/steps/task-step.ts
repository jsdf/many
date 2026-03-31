// Task step executor — launches a task via worktree-service, polls for
// completion, reads the log file, and extracts structured outputs.

import { promises as fs } from "fs";
import type { TaskStep, TemplateContext } from "../types.js";
import { resolveTemplate } from "../template.js";
import { extractAllOutputs } from "../output-parser.js";
import {
  launchTask,
  type LaunchTaskResult,
} from "../../services/worktree-service.js";
import {
  getTask,
  type TaskRecord,
} from "../../cli/task-registry.js";
import { loadAppData, type PoolConfig } from "../../cli/config.js";
import type { OnProgress, RunCommand } from "../../services/types.js";

const POLL_INTERVAL_MS = 5_000;

export interface TaskStepResult {
  exitCode: number;
  outputs: Record<string, string>;
  taskId: string;
  worktreePath: string;
  branch: string;
}

export async function executeTaskStep(
  step: TaskStep,
  context: TemplateContext,
  repoPath: string,
  onProgress?: OnProgress,
  runCommand?: RunCommand
): Promise<TaskStepResult> {
  const prompt = resolveTemplate(step.prompt, context);
  const startingPoint = step.startingPoint
    ? resolveTemplate(step.startingPoint, context)
    : undefined;

  // Look up pool config to get task command and pool type
  const appData = await loadAppData();
  const repoConfig = appData.repositoryConfigs[repoPath];
  const pool = repoConfig?.pools?.find(
    (p: PoolConfig) => p.prefix === step.poolPrefix
  );

  if (!pool) {
    throw new Error(
      `Pool with prefix "${step.poolPrefix}" not found for repo ${repoPath}`
    );
  }

  if (!pool.taskCommand) {
    throw new Error(
      `Pool "${pool.name}" has no taskCommand configured`
    );
  }

  // Launch the task (this acquires a worktree, claims it, runs maintenance, registers the task)
  const launchResult: LaunchTaskResult = await launchTask(
    repoPath,
    {
      poolType: pool.type,
      poolPrefix: pool.prefix,
      prompt,
      startingPoint,
      maintenanceCommand: pool.maintenanceCommand,
      initCommand: repoConfig?.initCommand,
      mainBranch: repoConfig?.mainBranch ?? null,
      worktreeDirectory: repoConfig?.worktreeDirectory ?? null,
      taskCommand: pool.taskCommand,
      launchedBy: "web",
    },
    onProgress,
    runCommand
  );

  const { taskRecord, worktreePath, branch } = launchResult;

  onProgress?.({
    type: "step",
    text: `Task ${taskRecord.id} launched, waiting for completion...`,
  });

  // Now we need to actually spawn the task process.
  // The task step spawns the task command itself and waits for it.
  const exitCode = await spawnAndWaitForTask(
    pool.taskCommand,
    worktreePath,
    prompt,
    taskRecord.id,
    runCommand
  );

  // Read the task log
  const logContent = await readTaskLog(taskRecord.id);

  // Extract outputs from log content
  const outputs = extractAllOutputs(logContent, step.outputs, exitCode);

  // Auto-export standard fields
  outputs["worktreePath"] = worktreePath;
  outputs["branch"] = branch;
  outputs["taskId"] = taskRecord.id;
  outputs["exitCode"] = String(exitCode);

  return {
    exitCode,
    outputs,
    taskId: taskRecord.id,
    worktreePath,
    branch,
  };
}

async function spawnAndWaitForTask(
  taskCommand: string,
  cwd: string,
  prompt: string,
  taskId: string,
  runCommand?: RunCommand
): Promise<number> {
  if (runCommand) {
    // Use the provided RunCommand (which handles spawning + stdio)
    return runCommand(taskCommand, cwd, undefined);
  }

  // Fallback: spawn directly and wait
  const { spawn } = await import("child_process");
  const userShell = process.env.SHELL || "/bin/bash";

  return new Promise((resolve) => {
    const child = spawn(userShell, ["-l", "-c", taskCommand], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MANY_TASK_PROMPT: prompt,
        MANY_TASK_ID: taskId,
      },
    });

    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function readTaskLog(taskId: string): Promise<string> {
  const task = await getTask(taskId);
  if (!task?.logFile) return "";

  try {
    return await fs.readFile(task.logFile, "utf-8");
  } catch {
    return "";
  }
}
