// Workflow system types

// === Triggers ===

export interface ManualTrigger {
  type: "manual";
}

export interface WebhookTrigger {
  type: "webhook";
  path: string;
  secret?: string;
}

export type EmailExtractor =
  | { source: "subject_regex"; group: number | string }
  | { source: "body_regex"; pattern: string; group?: number }
  | { source: "header"; name: string };

export interface EmailTrigger {
  type: "email";
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
    tls: boolean;
  };
  filter: { from?: string; subjectRegex?: string };
  extract: Record<string, EmailExtractor>;
  pollIntervalSec: number;
}

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export type WorkflowTrigger =
  | ManualTrigger
  | WebhookTrigger
  | EmailTrigger
  | CronTrigger;

// === Output extraction ===

export type OutputExtractor =
  | { type: "sentinel_json"; field?: string }
  | { type: "json_field"; field: string }
  | { type: "regex"; pattern: string; group?: number }
  | { type: "exit_code" }
  | { type: "full_output" };

export interface OutputSpec {
  name: string;
  extractor: OutputExtractor;
}

// === Steps ===

export interface TaskStep {
  id: string;
  name: string;
  type: "task";
  poolPrefix: string;
  prompt: string;
  startingPoint?: string;
  outputs: OutputSpec[];
  onFailure: "stop" | "continue";
}

export interface BashStep {
  id: string;
  name: string;
  type: "bash";
  script: string;
  cwd?: string;
  outputs: OutputSpec[];
  onFailure: "stop" | "continue";
}

export type WorkflowStep = TaskStep | BashStep;

// === Workflow Definition ===

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  repoPath: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// === Workflow Runs ===

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StepRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface StepRun {
  stepId: string;
  stepName: string;
  status: StepRunStatus;
  taskId?: string;
  outputs: Record<string, string>;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  triggerData: Record<string, string>;
  steps: StepRun[];
  startedAt: string;
  endedAt?: string;
  error?: string;
}

// === Template context ===

export interface TemplateContext {
  trigger: Record<string, string>;
  steps: Record<string, Record<string, string>>;
}

// === Progress events ===

export type WorkflowProgressEvent =
  | { type: "run_start"; runId: string; workflowName: string }
  | { type: "step_start"; runId: string; stepId: string; stepName: string }
  | {
      type: "step_complete";
      runId: string;
      stepId: string;
      outputs: Record<string, string>;
    }
  | { type: "step_failed"; runId: string; stepId: string; error: string }
  | { type: "run_complete"; runId: string; status: WorkflowRunStatus };
