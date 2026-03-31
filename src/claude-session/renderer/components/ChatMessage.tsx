import React, { useState } from "react";
import type { SessionMessage, ContentBlock, ToolUse, ToolResult } from "../../shared/protocol.js";

// ---------------------------------------------------------------------------
// Tool call pill
// ---------------------------------------------------------------------------

function ToolCallPill({ toolUse }: { toolUse: ToolUse }) {
  const [open, setOpen] = useState(false);

  // Pick a short preview from common tool inputs
  const preview =
    (toolUse.input as any).command ??
    (toolUse.input as any).file_path ??
    (toolUse.input as any).pattern ??
    (toolUse.input as any).path ??
    (toolUse.input as any).description ??
    "";

  const previewText =
    typeof preview === "string" && preview.length > 80
      ? preview.slice(0, 80) + "…"
      : String(preview);

  return (
    <div className="my-1">
      <button
        className="btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-accent">⚙</span>
        <span>{toolUse.name}</span>
        {previewText && (
          <span className="opacity-50 max-w-[300px] truncate">
            {previewText}
          </span>
        )}
        <span className="opacity-40">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
          {JSON.stringify(toolUse.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool result block
// ---------------------------------------------------------------------------

function ToolResultBlock({ toolResult }: { toolResult: ToolResult }) {
  const [open, setOpen] = useState(false);
  const truncated =
    toolResult.output.length > 200
      ? toolResult.output.slice(0, 200) + "…"
      : toolResult.output;

  return (
    <div className="my-1">
      <button
        className={`btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100 ${
          toolResult.isError ? "text-error" : "text-success"
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{toolResult.isError ? "✗" : "✓"}</span>
        <span className="opacity-50 max-w-[400px] truncate">
          {truncated}
        </span>
        {toolResult.output.length > 200 && (
          <span className="opacity-40">{open ? "▲" : "▼"}</span>
        )}
      </button>

      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">
          {toolResult.output}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking block
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1">
      <button
        className="btn btn-xs btn-ghost gap-1 text-xs text-warning opacity-70 hover:opacity-100"
        onClick={() => setOpen((o) => !o)}
      >
        <span>💭</span>
        <span>thinking</span>
        <span className="opacity-40">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap opacity-70">
          {text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content block renderer
// ---------------------------------------------------------------------------

function ContentBlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return (
        <div className="whitespace-pre-wrap break-words">{block.text}</div>
      );
    case "thinking":
      return <ThinkingBlock text={block.thinking} />;
    case "tool_use":
      return <ToolCallPill toolUse={block.toolUse} />;
    case "tool_result":
      return <ToolResultBlock toolResult={block.toolResult} />;
  }
}

// ---------------------------------------------------------------------------
// Main message component
// ---------------------------------------------------------------------------

export function ChatMessage({ message }: { message: SessionMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // Skip empty messages (tool-result-only user messages are common)
  const hasVisibleContent = message.content.some(
    (b) => b.type === "text" || b.type === "thinking"
  );
  const hasTools = message.content.some(
    (b) => b.type === "tool_use" || b.type === "tool_result"
  );

  if (!hasVisibleContent && !hasTools) return null;

  return (
    <div
      className={`flex flex-col gap-0.5 px-3 py-2 ${
        isUser ? "bg-base-200/50" : ""
      }`}
    >
      <div className="flex items-center gap-2 text-xs opacity-50 mb-0.5">
        <span className={isUser ? "text-primary" : "text-secondary"}>
          {isUser ? "You" : isSystem ? "System" : "Claude"}
        </span>
      </div>

      <div className="text-sm">
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>

      {message.error && (
        <div className="text-xs text-error mt-1">Error: {message.error}</div>
      )}
    </div>
  );
}
