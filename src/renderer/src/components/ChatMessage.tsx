import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight } from "lucide-react";

const REMARK_PLUGINS = [remarkGfm];

export interface SessionMessage {
  ordinal: number;
  role: string;
  text: string;
  timestamp: number | null;
  toolUses: { name: string; input: string }[];
}

const TOOL_MARKER_RE = /\[Tool: [^\]]+\]\n?/g;
function stripToolMarkers(text: string): string {
  return text.replace(TOOL_MARKER_RE, "").trim();
}

function summarizeToolUses(tools: { name: string; input: string }[]): { name: string; input: string; count: number }[] {
  const result: { name: string; input: string; count: number }[] = [];
  for (const tool of tools) {
    const last = result[result.length - 1];
    if (last && last.name === tool.name) {
      last.count++;
    } else {
      result.push({ name: tool.name, input: tool.input, count: 1 });
    }
  }
  return result;
}

function formatToolInput(input: string): string {
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null) return input;
    const summary = parsed.command
      ?? parsed.pattern
      ?? parsed.file_path
      ?? parsed.path
      ?? parsed.query
      ?? parsed.description
      ?? parsed.prompt;
    if (typeof summary === "string") {
      return summary.length > 80 ? summary.slice(0, 80) + "\u2026" : summary;
    }
    return "";
  } catch {
    return "";
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ROLE_LABELS: Record<string, string> = {
  user: "You",
  assistant: "Claude",
};

const ROLE_LABEL_COLORS: Record<string, string> = {
  user: "text-primary",
  assistant: "text-secondary",
};

function ToolUseList({ tools }: { tools: { name: string; input: string; count: number }[] }) {
  return (
    <div className="flex flex-col gap-1">
      {tools.map((tool, i) => {
        const param = formatToolInput(tool.input);
        return (
          <div key={i} className="flex items-baseline gap-1.5 text-[11px] text-base-content/60 font-mono truncate">
            <span className="px-2 py-0.5 rounded-md bg-base-300 flex-shrink-0">
              {tool.name}{tool.count > 1 ? ` \u00d7${tool.count}` : ""}
            </span>
            {param && <span className="truncate text-base-content/40">{param}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ToolUseSummary({ toolUses, toolOnly }: { toolUses: { name: string; input: string }[]; toolOnly: boolean }) {
  const summarized = summarizeToolUses(toolUses);
  const totalCount = toolUses.length;
  const summaryLabel = summarized
    .map((t) => t.name + (t.count > 1 ? ` \u00d7${t.count}` : ""))
    .join(", ");

  if (toolOnly) {
    return (
      <details className="mb-2 group">
        <summary className="cursor-pointer text-[11px] text-base-content/50 font-mono select-none list-none flex items-center gap-1.5">
          <span className="text-base-content/30 group-open:rotate-90 transition-transform inline-flex"><ChevronRight size={12} /></span>
          <span className="px-2 py-0.5 rounded-md bg-base-300">{totalCount} tool use{totalCount !== 1 ? "s" : ""}</span>
          <span className="truncate text-base-content/40">{summaryLabel}</span>
        </summary>
        <div className="mt-1.5 ml-4">
          <ToolUseList tools={summarized} />
        </div>
      </details>
    );
  }

  return (
    <div className="mb-2">
      <ToolUseList tools={summarized} />
    </div>
  );
}

interface ChatMessageProps {
  message: SessionMessage;
  toolUses?: { name: string; input: string }[];
}

export const ChatMessage = memo(function ChatMessage({ message, toolUses: toolUsesOverride }: ChatMessageProps) {
  const isUser = message.role === "user";
  const cleanText = stripToolMarkers(message.text);
  const hasText = cleanText.length > 0;
  const toolUses = toolUsesOverride ?? message.toolUses;
  const hasTools = toolUses.length > 0;

  if (!hasText && !hasTools) return null;

  const bgClass = isUser ? "bg-base-200" : "bg-base-100";
  const roleLabel = ROLE_LABELS[message.role] ?? message.role;
  const roleLabelColor = ROLE_LABEL_COLORS[message.role] ?? "text-base-content/60";

  return (
    <div className={`px-4 py-2 ${bgClass}`}>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-semibold ${roleLabelColor}`}>
            {roleLabel}
          </span>
          {message.timestamp && (
            <span className="text-[10px] text-base-content/40">
              {formatTime(message.timestamp)}
            </span>
          )}
        </div>

        {hasTools && <ToolUseSummary toolUses={toolUses} toolOnly={!hasText} />}

        {hasText && (
          <div className="prose prose-sm max-w-none break-words">
            <Markdown remarkPlugins={REMARK_PLUGINS}>{cleanText}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
});

/** Coalesce consecutive tool-only messages into single display items. */
export interface DisplayItem {
  message: SessionMessage;
  ordinals: number[];
  toolUses: { name: string; input: string }[];
  count: number;
}

function isToolOnly(msg: SessionMessage): boolean {
  if (msg.role !== "assistant" || msg.toolUses.length === 0) return false;
  return stripToolMarkers(msg.text) === "";
}

function isEmptyToolResult(msg: SessionMessage): boolean {
  return msg.role === "user" && msg.text.trim() === "" && msg.toolUses.length === 0;
}

function isCoalescable(msg: SessionMessage): boolean {
  return isToolOnly(msg) || isEmptyToolResult(msg);
}

export function coalesceMessages(messages: SessionMessage[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (isToolOnly(msg)) {
      const toolUses: { name: string; input: string }[] = [];
      const ordinals: number[] = [];
      const first = msg;
      while (i < messages.length && isCoalescable(messages[i])) {
        if (isToolOnly(messages[i])) {
          toolUses.push(...messages[i].toolUses);
        }
        ordinals.push(messages[i].ordinal);
        i++;
      }
      result.push({ message: first, ordinals, toolUses, count: ordinals.length });
    } else {
      if (isEmptyToolResult(msg)) {
        i++;
        continue;
      }
      result.push({
        message: msg,
        ordinals: [msg.ordinal],
        toolUses: msg.toolUses,
        count: 1,
      });
      i++;
    }
  }
  return result;
}
