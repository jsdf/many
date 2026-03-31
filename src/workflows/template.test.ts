import { describe, it, expect } from "vitest";
import {
  resolveTemplate,
  hasTemplateVars,
  listTemplateVars,
} from "./template.js";
import type { TemplateContext } from "./types.js";

const ctx: TemplateContext = {
  trigger: {
    branch: "feature/login",
    build_url: "https://circleci.com/build/123",
    status: "failed",
  },
  steps: {
    analyze: {
      summary: "null check missing in auth.ts",
      severity: "high",
      worktreePath: "/tmp/wt-1",
    },
    fix: {
      pr_url: "https://github.com/org/repo/pull/42",
      exitCode: "0",
    },
  },
};

describe("resolveTemplate", () => {
  it("resolves trigger variables", () => {
    expect(resolveTemplate("branch: {{trigger.branch}}", ctx)).toBe(
      "branch: feature/login"
    );
  });

  it("resolves step output variables", () => {
    expect(resolveTemplate("{{steps.analyze.summary}}", ctx)).toBe(
      "null check missing in auth.ts"
    );
  });

  it("resolves multiple variables in one template", () => {
    const result = resolveTemplate(
      "Fix {{steps.analyze.summary}} on {{trigger.branch}}",
      ctx
    );
    expect(result).toBe(
      "Fix null check missing in auth.ts on feature/login"
    );
  });

  it("resolves nested step references", () => {
    expect(resolveTemplate("PR: {{steps.fix.pr_url}}", ctx)).toBe(
      "PR: https://github.com/org/repo/pull/42"
    );
  });

  it("throws on unresolved variable", () => {
    expect(() =>
      resolveTemplate("{{trigger.nonexistent}}", ctx)
    ).toThrow("Unresolved template variable: {{trigger.nonexistent}}");
  });

  it("throws on unknown step", () => {
    expect(() =>
      resolveTemplate("{{steps.missing.value}}", ctx)
    ).toThrow("Unresolved template variable: {{steps.missing.value}}");
  });

  it("returns string unchanged if no template vars", () => {
    expect(resolveTemplate("plain text", ctx)).toBe("plain text");
  });
});

describe("hasTemplateVars", () => {
  it("returns true for templates", () => {
    expect(hasTemplateVars("{{trigger.x}}")).toBe(true);
  });

  it("returns false for plain strings", () => {
    expect(hasTemplateVars("no vars here")).toBe(false);
  });
});

describe("listTemplateVars", () => {
  it("lists all variables in a template", () => {
    const vars = listTemplateVars(
      "{{trigger.branch}} and {{steps.analyze.summary}}"
    );
    expect(vars).toEqual(["trigger.branch", "steps.analyze.summary"]);
  });

  it("returns empty array for plain string", () => {
    expect(listTemplateVars("nothing")).toEqual([]);
  });
});
