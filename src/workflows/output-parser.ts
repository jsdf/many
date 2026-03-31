// Output extraction from step results
// Supports sentinel-based JSON blocks, regex capture, json field extraction

import type { OutputSpec, OutputExtractor } from "./types.js";

const SENTINEL_START = "---MANY_OUTPUT_START---";
const SENTINEL_END = "---MANY_OUTPUT_END---";

export function extractSentinelJson(content: string): unknown | null {
  // Find the last sentinel block (in case Claude outputs multiple)
  const startIdx = content.lastIndexOf(SENTINEL_START);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + SENTINEL_START.length;
  const endIdx = content.indexOf(SENTINEL_END, jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = content.slice(jsonStart, endIdx).trim();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function extractBySpec(
  content: string,
  spec: OutputSpec,
  exitCode?: number
): string {
  return applyExtractor(content, spec.extractor, exitCode);
}

function applyExtractor(
  content: string,
  extractor: OutputExtractor,
  exitCode?: number
): string {
  switch (extractor.type) {
    case "sentinel_json": {
      const json = extractSentinelJson(content);
      if (json === null) return "";
      if (extractor.field) {
        const val = (json as Record<string, unknown>)[extractor.field];
        return val === undefined ? "" : String(val);
      }
      return JSON.stringify(json);
    }

    case "json_field": {
      // Try to parse entire output as JSON
      try {
        const parsed = JSON.parse(content.trim());
        const val = parsed[extractor.field];
        return val === undefined ? "" : String(val);
      } catch {
        return "";
      }
    }

    case "regex": {
      const re = new RegExp(extractor.pattern);
      const match = re.exec(content);
      if (!match) return "";
      const group = extractor.group ?? 1;
      return match[group] ?? match[0] ?? "";
    }

    case "exit_code":
      return exitCode !== undefined ? String(exitCode) : "";

    case "full_output":
      return content;
  }
}

export function extractAllOutputs(
  content: string,
  specs: OutputSpec[],
  exitCode?: number
): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const spec of specs) {
    outputs[spec.name] = extractBySpec(content, spec, exitCode);
  }
  return outputs;
}
