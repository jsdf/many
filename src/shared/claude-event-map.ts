import type { ClaudeEvent } from "@libclaude/core";
import type { ClaudeUiEvent, ClaudeUiContentBlock } from "./protocol.js";

export function mapContentBlock(block: { type: string; [k: string]: unknown }): ClaudeUiContentBlock | null {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      input: block.input,
    };
  }
  if (block.type === "tool_result") {
    const content = block.content;
    const text = Array.isArray(content)
      ? content.map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c))).join("")
      : typeof content === "string"
        ? content
        : JSON.stringify(content);
    return {
      type: "tool_result",
      toolUseId: String(block.tool_use_id ?? ""),
      content: text,
      isError: block.is_error === true,
    };
  }
  return null;
}

export function mapClaudeEvent(evt: ClaudeEvent): ClaudeUiEvent | null {
  if (evt.type === "system" && (evt as any).subtype === "init") {
    return { type: "init", sessionId: String((evt as any).session_id ?? "") };
  }
  if (evt.type === "assistant") {
    const content = (evt as any).message?.content;
    if (!Array.isArray(content)) return null;
    const blocks = content.map(mapContentBlock).filter((b): b is ClaudeUiContentBlock => b !== null);
    return { type: "assistant", content: blocks };
  }
  if (evt.type === "user") {
    const content = (evt as any).message?.content;
    if (!Array.isArray(content)) return null;
    const blocks = content.map(mapContentBlock).filter((b): b is ClaudeUiContentBlock => b !== null);
    if (blocks.length === 0) return null;
    return { type: "user", content: blocks };
  }
  if (evt.type === "result") {
    const r = evt as any;
    return {
      type: "result",
      isError: r.is_error === true,
      costUsd: r.total_cost_usd,
      durationMs: r.duration_ms,
    };
  }
  return null;
}
