// Bash step executor — runs a shell script, captures output, extracts outputs

import { spawn } from "child_process";
import type { BashStep, TemplateContext } from "../types.js";
import { resolveTemplate } from "../template.js";
import { extractAllOutputs } from "../output-parser.js";

const userShell = process.env.SHELL || "/bin/bash";

export interface BashStepResult {
  exitCode: number;
  output: string;
  outputs: Record<string, string>;
}

export async function executeBashStep(
  step: BashStep,
  context: TemplateContext,
  defaultCwd: string
): Promise<BashStepResult> {
  const script = resolveTemplate(step.script, context);
  const cwd = step.cwd ? resolveTemplate(step.cwd, context) : defaultCwd;

  const { exitCode, output } = await runScript(script, cwd);

  const outputs = extractAllOutputs(output, step.outputs, exitCode);

  return { exitCode, output, outputs };
}

function runScript(
  script: string,
  cwd: string
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(userShell, ["-li", "-c", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const chunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (err) => {
      resolve({
        exitCode: 1,
        output: Buffer.concat(chunks).toString() + "\n" + err.message,
      });
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString(),
      });
    });
  });
}
