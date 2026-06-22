import type { ClaudeEvent } from "@libclaude/rpc";

export type DisplayBlock =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; isError: boolean; content: unknown };

/** Flatten a turn's raw CLI events into renderable blocks, in order. */
export function eventsToBlocks(events: ClaudeEvent[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  for (const evt of events) {
    if (evt.type === "assistant" || evt.type === "user") {
      const content = (evt as { message?: { content?: unknown } }).message?.content;
      if (typeof content === "string") {
        if (content) blocks.push({ kind: "text", text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          blocks.push({ kind: "text", text: b.text });
        } else if (b.type === "tool_use") {
          blocks.push({ kind: "tool_use", name: String(b.name ?? "tool"), input: b.input });
        } else if (b.type === "tool_result") {
          blocks.push({ kind: "tool_result", isError: b.is_error === true, content: b.content });
        }
      }
    }
  }
  return blocks;
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
