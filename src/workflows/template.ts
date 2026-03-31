// Template variable resolver for workflow steps
// Resolves {{trigger.x}} and {{steps.stepId.varName}} patterns

import type { TemplateContext } from "./types.js";

const TEMPLATE_PATTERN = /\{\{([^}]+)\}\}/g;

export function resolveTemplate(
  template: string,
  context: TemplateContext
): string {
  return template.replace(TEMPLATE_PATTERN, (match, path: string) => {
    const value = resolvePath(path.trim(), context);
    if (value === undefined) {
      throw new Error(`Unresolved template variable: ${match}`);
    }
    return value;
  });
}

function resolvePath(
  dotPath: string,
  context: TemplateContext
): string | undefined {
  const parts = dotPath.split(".");
  if (parts.length < 2) return undefined;

  const [root, ...rest] = parts;

  if (root === "trigger") {
    return context.trigger[rest.join(".")];
  }

  if (root === "steps" && rest.length >= 2) {
    const [stepId, ...varParts] = rest;
    const stepOutputs = context.steps[stepId];
    if (!stepOutputs) return undefined;
    return stepOutputs[varParts.join(".")];
  }

  return undefined;
}

export function hasTemplateVars(template: string): boolean {
  return TEMPLATE_PATTERN.test(template);
}

export function listTemplateVars(template: string): string[] {
  const vars: string[] = [];
  let m;
  const re = new RegExp(TEMPLATE_PATTERN.source, "g");
  while ((m = re.exec(template)) !== null) {
    vars.push(m[1].trim());
  }
  return vars;
}
