// Workflow definition persistence

import path from "path";
import { getDataPath } from "../cli/config.js";
import { JsonStore } from "./json-store.js";
import type { WorkflowDefinition } from "./types.js";

interface WorkflowRegistryData {
  workflows: WorkflowDefinition[];
}

const defaultData: WorkflowRegistryData = { workflows: [] };

function getStore() {
  return new JsonStore<WorkflowRegistryData>(
    path.join(getDataPath(), "workflow-definitions.json"),
    defaultData
  );
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `wf-${ts}-${rand}`;
}

export async function createWorkflow(
  fields: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">
): Promise<WorkflowDefinition> {
  return getStore().withLock(async (data) => {
    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    data.workflows.push(workflow);
    return { result: workflow, save: true };
  });
}

export async function updateWorkflow(
  id: string,
  updates: Partial<
    Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">
  >
): Promise<WorkflowDefinition | null> {
  return getStore().withLock(async (data) => {
    const workflow = data.workflows.find((w) => w.id === id);
    if (!workflow) return { result: null, save: false };

    Object.assign(workflow, updates, { updatedAt: new Date().toISOString() });
    return { result: workflow, save: true };
  });
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  return getStore().withLock(async (data) => {
    const before = data.workflows.length;
    data.workflows = data.workflows.filter((w) => w.id !== id);
    const removed = data.workflows.length < before;
    return { result: removed, save: removed };
  });
}

export async function getWorkflow(
  id: string
): Promise<WorkflowDefinition | null> {
  const data = await getStore().load();
  return data.workflows.find((w) => w.id === id) ?? null;
}

export async function listWorkflows(
  repoPath?: string
): Promise<WorkflowDefinition[]> {
  const data = await getStore().load();
  let workflows = data.workflows;
  if (repoPath) {
    workflows = workflows.filter((w) => w.repoPath === repoPath);
  }
  return workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
