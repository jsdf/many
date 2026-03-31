// Workflow execution engine
// Runs a workflow definition step-by-step, resolving templates,
// executing steps, and persisting run state after each step.

import type {
  WorkflowDefinition,
  WorkflowRun,
  StepRun,
  TemplateContext,
  WorkflowProgressEvent,
  WorkflowStep,
} from "./types.js";
import {
  createRun,
  updateRun,
  updateRunStatus,
  updateStepRun,
} from "./workflow-run-registry.js";
import { executeBashStep } from "./steps/bash-step.js";
import { executeTaskStep } from "./steps/task-step.js";
import type { OnProgress, RunCommand } from "../services/types.js";

export type OnWorkflowProgress = (event: WorkflowProgressEvent) => void;

export class WorkflowRunner {
  private runCommand?: RunCommand;
  private onProgress?: OnWorkflowProgress;

  constructor(options?: {
    runCommand?: RunCommand;
    onProgress?: OnWorkflowProgress;
  }) {
    this.runCommand = options?.runCommand;
    this.onProgress = options?.onProgress;
  }

  async executeWorkflow(
    workflow: WorkflowDefinition,
    triggerData: Record<string, string>
  ): Promise<WorkflowRun> {
    // Initialize run record
    const stepRuns: StepRun[] = workflow.steps.map((step) => ({
      stepId: step.id,
      stepName: step.name,
      status: "pending" as const,
      outputs: {},
    }));

    const run = await createRun({
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "running",
      triggerData,
      steps: stepRuns,
    });

    this.emitProgress({
      type: "run_start",
      runId: run.id,
      workflowName: workflow.name,
    });

    // Build template context — accumulates outputs as steps complete
    const context: TemplateContext = {
      trigger: triggerData,
      steps: {},
    };

    let failed = false;

    for (const step of workflow.steps) {
      if (failed) {
        // Mark remaining steps as skipped
        await updateStepRun(run.id, step.id, (s) => {
          s.status = "skipped";
        });
        continue;
      }

      try {
        await this.executeStep(run.id, step, context, workflow.repoPath);
      } catch (err: any) {
        const error = err.message ?? String(err);

        await updateStepRun(run.id, step.id, (s) => {
          s.status = "failed";
          s.error = error;
          s.endedAt = new Date().toISOString();
        });

        this.emitProgress({
          type: "step_failed",
          runId: run.id,
          stepId: step.id,
          error,
        });

        if (step.onFailure === "stop") {
          failed = true;
        }
        // If onFailure === "continue", keep going
      }
    }

    const finalStatus = failed ? "failed" : "completed";
    await updateRunStatus(run.id, finalStatus);

    this.emitProgress({
      type: "run_complete",
      runId: run.id,
      status: finalStatus,
    });

    // Return the final state
    const { getRun } = await import("./workflow-run-registry.js");
    return (await getRun(run.id))!;
  }

  private async executeStep(
    runId: string,
    step: WorkflowStep,
    context: TemplateContext,
    repoPath: string
  ): Promise<void> {
    // Mark step as running
    await updateStepRun(runId, step.id, (s) => {
      s.status = "running";
      s.startedAt = new Date().toISOString();
    });

    this.emitProgress({
      type: "step_start",
      runId,
      stepId: step.id,
      stepName: step.name,
    });

    // Build an OnProgress that wraps our workflow progress
    const stepProgress: OnProgress = (event) => {
      // Could forward these as more granular events if needed
      this.onProgress?.({
        type: "step_start",
        runId,
        stepId: step.id,
        stepName: `${step.name}: ${event.text}`,
      });
    };

    let outputs: Record<string, string>;

    switch (step.type) {
      case "bash": {
        const result = await executeBashStep(step, context, repoPath);
        if (result.exitCode !== 0 && step.onFailure === "stop") {
          throw new Error(
            `Bash step "${step.name}" exited with code ${result.exitCode}`
          );
        }
        outputs = result.outputs;
        break;
      }

      case "task": {
        const result = await executeTaskStep(
          step,
          context,
          repoPath,
          stepProgress,
          this.runCommand
        );
        if (result.exitCode !== 0 && step.onFailure === "stop") {
          throw new Error(
            `Task step "${step.name}" exited with code ${result.exitCode}`
          );
        }
        outputs = result.outputs;
        break;
      }

      default:
        throw new Error(
          `Unknown step type: ${(step as any).type}`
        );
    }

    // Store outputs in context for subsequent steps
    context.steps[step.id] = outputs;

    // Persist step completion
    await updateStepRun(runId, step.id, (s) => {
      s.status = "completed";
      s.outputs = outputs;
      s.endedAt = new Date().toISOString();
    });

    this.emitProgress({
      type: "step_complete",
      runId,
      stepId: step.id,
      outputs,
    });
  }

  private emitProgress(event: WorkflowProgressEvent): void {
    this.onProgress?.(event);
  }
}
