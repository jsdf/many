// AutomationService - orchestrates producer→worker automation runs.
// The producer task generates work items; workers consume them from a queue.

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
export const WORK_ITEMS_FILENAME = ".many-work-items.json";
const POLL_INTERVAL_MS = 3000;

export interface StartAutomationOptions {
  repoPath: string;
  automation: AutomationDefinition;
  repoConfig: RepositoryConfig;
  onProgress?: OnProgress;
  runCommand?: RunCommand;
  manualWorkItems?: string[];
}

/**
 * Start an automation run: launch the producer, wait for it to complete,
 * parse work items, then process the worker queue.
 *
 * This function runs for the lifetime of the automation — it's meant to be
 * called from an SSE endpoint so the client can stream progress.
 */
export async function startAutomationRun(
  options: StartAutomationOptions
): Promise<AutomationRun> {
  const { repoPath, automation, repoConfig, onProgress, manualWorkItems } = options;

  const pool = repoConfig.pools?.find((p) => p.prefix === automation.poolPrefix);
  if (!pool) {
    throw new Error(`Pool with prefix "${automation.poolPrefix}" not found`);
  }
  const taskCommand = pool.backgroundTaskCommand || pool.taskCommand;
  if (!taskCommand) {
    throw new Error(`Pool "${pool.name}" has no task command configured`);
  }

  const isManual = manualWorkItems && manualWorkItems.length > 0;

  // Create the automation run record
  const run = await createRun({
    automationId: automation.id,
    automationName: automation.name,
    repoPath,
    status: isManual ? "running" : "producing",
  });

  onProgress?.({ type: "step", text: `Automation run started: ${run.id}` });

  try {
    let prompts: string[];

    if (isManual) {
      // Skip producer — use manually provided work items
      prompts = manualWorkItems;
      onProgress?.({
        type: "step",
        text: `Manual run with ${prompts.length} work item(s)`,
      });
      await addWorkItems(run.id, prompts);
    } else {
      // Phase 1: Launch producer
      onProgress?.({ type: "step", text: "Launching producer task..." });

      const logDir = repoConfig.terminalLogDir || getTaskLogDir();
      await fs.mkdir(logDir, { recursive: true });
      const producerLogFile = path.join(logDir, `${run.id}-producer.log`);

      const producerPrompt =
        automation.producerPrompt +
        `\n\nIMPORTANT: You must write your output to a file called "${WORK_ITEMS_FILENAME}" in the worktree root. ` +
        `The file must contain a JSON array of strings, where each string is a work item prompt for a worker task. ` +
        `Example: ["implement user auth", "add search API", "write tests for billing"]\n` +
        `Before finishing, run "many validate-work-items" to verify the file is correctly formatted.`;

      const producerResult = await launchTask(
        repoPath,
        {
          poolType: pool.type,
          poolPrefix: pool.prefix,
          prompt: producerPrompt,
          maintenanceCommand: pool.maintenanceCommand,
          initCommand: repoConfig.initCommand,
          mainBranch: repoConfig.mainBranch,
          worktreeDirectory: repoConfig.worktreeDirectory,
          taskCommand,
          launchedBy: "web",
          logFile: producerLogFile,
        },
        onProgress,
        options.runCommand
      );

      await updateRun(run.id, {
        producerTaskId: producerResult.taskRecord.id,
        producerWorktreePath: producerResult.worktreePath,
      });

      onProgress?.({
        type: "step",
        text: `Producer task registered: ${producerResult.taskRecord.id}`,
      });

      // Spawn the producer process directly (background, captured to log file)
      const producerExitCode = await spawnTaskProcess(
        taskCommand,
        producerResult.worktreePath,
        producerPrompt,
        producerLogFile,
        producerResult.taskRecord.id,
        onProgress
      );

      if (producerExitCode !== 0) {
        onProgress?.({
          type: "error",
          text: `Producer failed with exit code ${producerExitCode}`,
        });
        await updateRun(run.id, { status: "failed" });
        return (await getRun(run.id))!;
      }

      onProgress?.({ type: "step", text: "Producer completed, reading work items..." });

      // Phase 2: Read work items from producer worktree
      const workItemsPath = path.join(
        producerResult.worktreePath,
        WORK_ITEMS_FILENAME
      );

      try {
        const raw = await fs.readFile(workItemsPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) {
          throw new Error("Expected JSON array of strings");
        }
        prompts = parsed.filter((p: string) => p.trim().length > 0);
      } catch (err: any) {
        onProgress?.({
          type: "error",
          text: `Failed to read work items from ${WORK_ITEMS_FILENAME}: ${err.message}`,
        });
        await updateRun(run.id, { status: "failed" });
        return (await getRun(run.id))!;
      }

      if (prompts.length === 0) {
        onProgress?.({ type: "step", text: "No work items produced. Completing." });
        await updateRun(run.id, { status: "completed" });
        return (await getRun(run.id))!;
      }

      onProgress?.({
        type: "step",
        text: `Producer generated ${prompts.length} work item(s)`,
      });

      // Add work items to the run
      await addWorkItems(run.id, prompts);

      // Release producer worktree back to pool
      try {
        await releaseWorktreeByPath(
          repoPath,
          producerResult.worktreePath,
          repoConfig.mainBranch,
          true // force
        );
        onProgress?.({ type: "step", text: "Producer worktree released back to pool" });
      } catch (err: any) {
        onProgress?.({
          type: "step",
          text: `Could not release producer worktree: ${err.message} (continuing)`,
        });
      }
    }

    // Phase 3: Process work queue
    await updateRun(run.id, { status: "running" });
    onProgress?.({
      type: "step",
      text: `Starting worker queue (concurrency: ${automation.concurrency})...`,
    });

    await processWorkQueue(
      run.id,
      repoPath,
      automation,
      repoConfig,
      pool,
      taskCommand,
      onProgress,
      options.runCommand
    );

    // Final status
    const finalRun = await getRun(run.id);
    if (finalRun && finalRun.status === "running") {
      const allDone = finalRun.workItems.every(
        (i) => i.status === "completed" || i.status === "failed"
      );
      if (allDone) {
        const anyFailed = finalRun.workItems.some((i) => i.status === "failed");
        await updateRun(run.id, {
          status: anyFailed ? "failed" : "completed",
        });
      }
    }

    return (await getRun(run.id))!;
  } catch (err: any) {
    onProgress?.({ type: "error", text: `Automation failed: ${err.message}` });
    await updateRun(run.id, { status: "failed" });
    return (await getRun(run.id))!;
  }
}

/**
 * Process the work item queue: launch workers up to concurrency, poll for
 * completion, launch more until all items are done.
 */
async function processWorkQueue(
  runId: string,
  repoPath: string,
  automation: AutomationDefinition,
  repoConfig: RepositoryConfig,
  pool: { type: "recyclable" | "ephemeral"; prefix: string; maintenanceCommand?: string },
  taskCommand: string,
  onProgress?: OnProgress,
  runCommand?: RunCommand
): Promise<void> {
  const logDir = repoConfig.terminalLogDir || getTaskLogDir();

  // Active workers: workItemId → promise
  const activeWorkers = new Map<string, Promise<void>>();

  const launchWorker = async (
    workItemId: string,
    prompt: string,
    workerIndex: number
  ): Promise<void> => {
    const workerLogFile = path.join(logDir, `${runId}-worker-${workerIndex}.log`);

    try {
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
          logFile: workerLogFile,
        },
        undefined, // don't spam progress for individual workers
        runCommand
      );

      await updateWorkItem(runId, workItemId, {
        status: "running",
        taskId: result.taskRecord.id,
        worktreePath: result.worktreePath,
      });

      onProgress?.({
        type: "step",
        text: `Worker ${workerIndex + 1} started: ${prompt.slice(0, 60)}...`,
      });

      // Spawn the worker process and wait for it
      const exitCode = await spawnTaskProcess(
        taskCommand,
        result.worktreePath,
        prompt,
        workerLogFile,
        result.taskRecord.id
      );

      await updateWorkItem(runId, workItemId, {
        status: exitCode === 0 ? "completed" : "failed",
      });

      onProgress?.({
        type: "step",
        text: `Worker ${workerIndex + 1} ${exitCode === 0 ? "completed" : `failed (exit ${exitCode})`}: ${prompt.slice(0, 60)}...`,
      });

      // Release worker worktree back to pool
      try {
        await releaseWorktreeByPath(
          repoPath,
          result.worktreePath,
          repoConfig.mainBranch,
          true
        );
      } catch {
        // non-critical
      }
    } catch (err: any) {
      await updateWorkItem(runId, workItemId, { status: "failed" });
      onProgress?.({
        type: "error",
        text: `Worker ${workerIndex + 1} failed to launch: ${err.message}`,
      });
    }
  };

  // Get initial work items
  let currentRun = await getRun(runId);
  if (!currentRun) return;

  let workerIndex = 0;

  while (true) {
    currentRun = await getRun(runId);
    if (!currentRun || currentRun.status === "cancelled") break;

    const pending = currentRun.workItems.filter((i) => i.status === "pending");
    const running = currentRun.workItems.filter((i) => i.status === "running");

    // All done?
    if (pending.length === 0 && running.length === 0 && activeWorkers.size === 0) {
      break;
    }

    // Fill up to concurrency
    const slotsAvailable = automation.concurrency - activeWorkers.size;
    const toLaunch = pending.slice(0, slotsAvailable);

    for (const item of toLaunch) {
      const idx = workerIndex++;
      const promise = launchWorker(item.id, item.prompt, idx).finally(() => {
        activeWorkers.delete(item.id);
      });
      activeWorkers.set(item.id, promise);
    }

    // If we have active workers, wait for at least one to complete
    if (activeWorkers.size > 0) {
      await Promise.race(activeWorkers.values());
    } else if (pending.length === 0) {
      // No active workers and no pending — we're done
      break;
    } else {
      // Shouldn't happen, but guard against infinite loop
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Wait for all remaining workers
  if (activeWorkers.size > 0) {
    await Promise.allSettled(activeWorkers.values());
  }
}

/**
 * Spawn a task command process, capture output to a log file, and wait
 * for it to exit. Updates the task registry with PID and exit code.
 */
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

    // Update task registry with actual PID
    updateTaskPid(taskId, child.pid ?? 0).catch(() => {});

    // Write output to log file
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

/**
 * Cancel a running automation: update status and kill all running worker tasks.
 */
export async function cancelAutomationRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run || (run.status !== "producing" && run.status !== "running")) return;

  await updateRun(runId, { status: "cancelled" });

  // Kill running workers
  const { killTask } = await import("../cli/task-registry.js");
  for (const item of run.workItems) {
    if (item.status === "running" && item.taskId) {
      await killTask(item.taskId).catch(() => {});
      await updateWorkItem(runId, item.id, { status: "failed" });
    }
  }

  // Kill producer if still running
  if (run.producerTaskId) {
    const producerTask = await getTask(run.producerTaskId);
    if (producerTask?.status === "running") {
      await killTask(run.producerTaskId).catch(() => {});
    }
  }
}
