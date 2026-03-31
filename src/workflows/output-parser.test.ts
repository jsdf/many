import { describe, it, expect } from "vitest";
import {
  extractSentinelJson,
  extractBySpec,
  extractAllOutputs,
} from "./output-parser.js";

const LOG_WITH_SENTINEL = `
Some task output here...
Analyzing the codebase...

---MANY_OUTPUT_START---
{"summary": "fix null check in auth.ts", "severity": "high", "files": ["src/auth.ts"]}
---MANY_OUTPUT_END---

Done.
`;

const LOG_WITHOUT_SENTINEL = `
Just regular output.
No structured data here.
`;

describe("extractSentinelJson", () => {
  it("extracts JSON from sentinel block", () => {
    const result = extractSentinelJson(LOG_WITH_SENTINEL);
    expect(result).toEqual({
      summary: "fix null check in auth.ts",
      severity: "high",
      files: ["src/auth.ts"],
    });
  });

  it("returns null when no sentinel block", () => {
    expect(extractSentinelJson(LOG_WITHOUT_SENTINEL)).toBeNull();
  });

  it("uses the last sentinel block if multiple exist", () => {
    const log = `
---MANY_OUTPUT_START---
{"version": 1}
---MANY_OUTPUT_END---
more output
---MANY_OUTPUT_START---
{"version": 2}
---MANY_OUTPUT_END---
`;
    expect(extractSentinelJson(log)).toEqual({ version: 2 });
  });

  it("returns null for malformed JSON in sentinel", () => {
    const log = `
---MANY_OUTPUT_START---
not json
---MANY_OUTPUT_END---
`;
    expect(extractSentinelJson(log)).toBeNull();
  });
});

describe("extractBySpec", () => {
  it("extracts sentinel JSON field", () => {
    const result = extractBySpec(LOG_WITH_SENTINEL, {
      name: "summary",
      extractor: { type: "sentinel_json", field: "summary" },
    });
    expect(result).toBe("fix null check in auth.ts");
  });

  it("extracts full sentinel JSON without field", () => {
    const result = extractBySpec(LOG_WITH_SENTINEL, {
      name: "data",
      extractor: { type: "sentinel_json" },
    });
    expect(JSON.parse(result)).toEqual({
      summary: "fix null check in auth.ts",
      severity: "high",
      files: ["src/auth.ts"],
    });
  });

  it("returns empty string when sentinel not found", () => {
    const result = extractBySpec(LOG_WITHOUT_SENTINEL, {
      name: "data",
      extractor: { type: "sentinel_json", field: "summary" },
    });
    expect(result).toBe("");
  });

  it("extracts via regex", () => {
    const log = "PR created: https://github.com/org/repo/pull/42\nDone.";
    const result = extractBySpec(log, {
      name: "pr_url",
      extractor: {
        type: "regex",
        pattern: "(https://github\\.com/[^\\s]+/pull/\\d+)",
      },
    });
    expect(result).toBe("https://github.com/org/repo/pull/42");
  });

  it("extracts regex with specific group", () => {
    const log = "Build status: FAILED on branch feature/login";
    const result = extractBySpec(log, {
      name: "status",
      extractor: {
        type: "regex",
        pattern: "Build status: (\\w+) on branch (\\S+)",
        group: 2,
      },
    });
    expect(result).toBe("feature/login");
  });

  it("returns empty string when regex doesn't match", () => {
    const result = extractBySpec("no match here", {
      name: "x",
      extractor: { type: "regex", pattern: "(zzz)" },
    });
    expect(result).toBe("");
  });

  it("extracts json_field from full output", () => {
    const result = extractBySpec('{"name": "test", "count": 5}', {
      name: "name",
      extractor: { type: "json_field", field: "name" },
    });
    expect(result).toBe("test");
  });

  it("returns exit code", () => {
    const result = extractBySpec("", {
      name: "code",
      extractor: { type: "exit_code" },
    }, 0);
    expect(result).toBe("0");
  });

  it("returns full output", () => {
    const result = extractBySpec("hello world", {
      name: "all",
      extractor: { type: "full_output" },
    });
    expect(result).toBe("hello world");
  });
});

describe("extractAllOutputs", () => {
  it("extracts multiple outputs", () => {
    const result = extractAllOutputs(
      LOG_WITH_SENTINEL,
      [
        {
          name: "summary",
          extractor: { type: "sentinel_json", field: "summary" },
        },
        {
          name: "severity",
          extractor: { type: "sentinel_json", field: "severity" },
        },
      ]
    );
    expect(result).toEqual({
      summary: "fix null check in auth.ts",
      severity: "high",
    });
  });
});
