// Workflow run record persistence

import path from "path";
import { getDataPath } from "../cli/config.js";
import { JsonStore } from "./json-store.js";
import type { WorkflowRun, WorkflowRunStatus, StepRun } from "./types.js";

interface WorkflowRunRegistryData {
  runs: WorkflowRun[];
}

const defaultData: WorkflowRunRegistryData = { runs: [] };

function getStore() {
  return new JsonStore<WorkflowRunRegistryData>(
    path.join(getDataPath(), "workflow-runs.json"),
    defaultData
  );
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `wfrun-${ts}-${rand}`;
}

export async function createRun(
  fields: Omit<WorkflowRun, "id" | "startedAt">
): Promise<WorkflowRun> {
  return getStore().withLock(async (data) => {
    const run: WorkflowRun = {
      id: generateRunId(),
      startedAt: new Date().toISOString(),
      ...fields,
    };
    data.runs.push(run);
    return { result: run, save: true };
  });
}

export async function updateRun(
  id: string,
  updater: (run: WorkflowRun) => void
): Promise<WorkflowRun | null> {
  return getStore().withLock(async (data) => {
    const run = data.runs.find((r) => r.id === id);
    if (!run) return { result: null, save: false };
    updater(run);
    return { result: run, save: true };
  });
}

export async function updateRunStatus(
  id: string,
  status: WorkflowRunStatus,
  error?: string
): Promise<void> {
  await updateRun(id, (run) => {
    run.status = status;
    if (error) run.error = error;
    if (status !== "running") run.endedAt = new Date().toISOString();
  });
}

export async function updateStepRun(
  runId: string,
  stepId: string,
  updater: (step: StepRun) => void
): Promise<void> {
  await updateRun(runId, (run) => {
    const step = run.steps.find((s) => s.stepId === stepId);
    if (step) updater(step);
  });
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  const data = await getStore().load();
  return data.runs.find((r) => r.id === id) ?? null;
}

export async function listRuns(filter?: {
  workflowId?: string;
  limit?: number;
}): Promise<WorkflowRun[]> {
  const data = await getStore().load();
  let runs = data.runs;
  if (filter?.workflowId) {
    runs = runs.filter((r) => r.workflowId === filter.workflowId);
  }
  runs = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (filter?.limit) {
    runs = runs.slice(0, filter.limit);
  }
  return runs;
}

export async function pruneOldRuns(maxAgeDays: number = 30): Promise<number> {
  return getStore().withLock(async (data) => {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const before = data.runs.length;

    data.runs = data.runs.filter((r) => {
      if (r.status === "running") return true;
      const ended = r.endedAt
        ? new Date(r.endedAt).getTime()
        : new Date(r.startedAt).getTime();
      return ended > cutoff;
    });

    const removed = before - data.runs.length;
    return { result: removed, save: removed > 0 };
  });
}
