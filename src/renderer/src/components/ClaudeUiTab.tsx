import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { getRpcClient } from "../rpc-client";
import { handleReadlineEdit } from "../readline-edit";
import { Settings2, ChevronUp, ChevronDown, ChevronRight, Check, X, AlertTriangle, Copy } from "lucide-react";
import type { ClaudeUiEvent, ClaudeUiContentBlock, ClaudeUiPermissionMode, ClaudeUiModel, ClaudeUiEffort } from "../../../shared/protocol";
import { MarkdownContent } from "./MarkdownContent";

const PERMISSION_MODES: { value: ClaudeUiPermissionMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
];

const MODELS: { value: ClaudeUiModel; label: string }[] = [
  { value: "default", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "fable", label: "Fable" },
];

const EFFORTS: { value: ClaudeUiEffort; label: string }[] = [
  { value: "default", label: "Default effort" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-high" },
  { value: "max", label: "Max" },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const preview = (input as any)?.command ?? (input as any)?.file_path ?? (input as any)?.pattern ?? (input as any)?.path ?? "";
  const text = typeof preview === "string" && preview.length > 80 ? preview.slice(0, 80) + "..." : String(preview ?? "");

  return (
    <div className="my-0.5">
      <button className="btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
        <span className="text-accent"><Settings2 size={12} /></span>
        <span>{name}</span>
        {text && <span className="opacity-50 max-w-[300px] truncate">{text}</span>}
        <span className="opacity-40">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultView({ content, isError }: { content: string; isError: boolean }) {
  const [open, setOpen] = useState(false);
  const truncated = content.length > 200 ? content.slice(0, 200) + "..." : content;

  return (
    <div className="my-0.5">
      <button
        className={`btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100 ${isError ? "text-error" : "text-success"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{isError ? <X size={12} /> : <Check size={12} />}</span>
        <span className="opacity-50 max-w-[400px] truncate">{truncated}</span>
        {content.length > 200 && <span className="opacity-40">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>}
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

// Copy-as-markdown button shown beside an assistant message.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="opacity-0 group-hover:opacity-100 transition-opacity text-base-content/40 hover:text-base-content/80"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => {});
      }}
      title="Copy as markdown"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-3 py-1">
      <button
        className="flex items-center gap-1.5 text-left text-xs font-mono text-base-content/40 hover:text-base-content/60 select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`inline-flex transition-transform ${open ? "rotate-90" : ""}`}>
          <ChevronRight size={12} />
        </span>
        <span>Thinking</span>
      </button>
      {open && (
        <div className="mt-1 ml-4 text-xs italic text-base-content/50 whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}

// A run of consecutive non-output activity (thinking, tool calls, tool
// results). Renders expanded (each entry on its own line, the way they stream
// in) while it is the latest activity, then auto-collapses to a one-line
// summary once an output message follows. Stays manually toggleable after that.
function ToolGroup({ entries, live }: { entries: ToolEntry[]; live: boolean }) {
  const [open, setOpen] = useState(live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) setOpen(false);
    wasLive.current = live;
  }, [live]);

  const uses = entries.filter((e): e is Extract<ToolEntry, { kind: "use" }> => e.kind === "use");
  const hasThinking = entries.some((e) => e.kind === "thinking");
  const summary: { name: string; count: number }[] = [];
  for (const u of uses) {
    const last = summary[summary.length - 1];
    if (last && last.name === u.name) last.count += 1;
    else summary.push({ name: u.name, count: 1 });
  }
  const labelParts = summary.map((s) => s.name + (s.count > 1 ? ` ×${s.count}` : ""));
  if (hasThinking) labelParts.unshift("thinking");
  const label = labelParts.join(", ");
  const total = uses.length;
  const badge = total > 0 ? `${total} tool${total !== 1 ? "s" : ""}` : "thinking";

  return (
    <div className="px-3 py-1">
      <button
        className="flex items-center gap-1.5 w-full text-left text-xs font-mono text-base-content/50 hover:text-base-content/70 select-none"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`text-base-content/40 inline-flex transition-transform ${open ? "rotate-90" : ""}`}>
          <ChevronRight size={12} />
        </span>
        <span className="px-2 py-0.5 rounded-md bg-base-300 shrink-0">{badge}</span>
        {total > 0 && label && <span className="truncate text-base-content/40">{label}</span>}
      </button>
      {open && (
        <div className="mt-0.5 ml-4">
          {entries.map((e) =>
            e.kind === "use" ? (
              <ToolUseBlock key={e.key} name={e.name} input={e.input} />
            ) : e.kind === "result" ? (
              <ToolResultView key={e.key} content={e.content} isError={e.isError} />
            ) : (
              <ThinkingBlock key={e.key} text={e.text} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display item types
// ---------------------------------------------------------------------------

type DisplayItem =
  | { kind: "prompt"; id: string; text: string; ts?: number }
  | { kind: "assistant"; id: string; content: ClaudeUiContentBlock[]; ts?: number }
  | { kind: "tool_feedback"; id: string; content: ClaudeUiContentBlock[] }
  | { kind: "result"; id: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: "error"; id: string; message: string };

// Render rows: assistant text becomes markdown, and consecutive non-output
// activity (thinking, tool calls, tool results) is coalesced into a single
// collapsible ToolGroup that spans across messages.
type ToolEntry =
  | { kind: "use"; key: string; name: string; input: unknown }
  | { kind: "result"; key: string; content: string; isError: boolean }
  | { kind: "thinking"; key: string; text: string };

type Row =
  | { kind: "prompt"; key: string; text: string; ts?: number }
  | { kind: "text"; key: string; text: string; ts?: number }
  | { kind: "tools"; key: string; entries: ToolEntry[] }
  | { kind: "result"; key: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: "error"; key: string; message: string };

function buildRows(items: DisplayItem[]): Row[] {
  const rows: Row[] = [];
  let tools: ToolEntry[] | null = null;
  const flushTools = () => {
    if (tools && tools.length > 0) rows.push({ kind: "tools", key: `tools:${tools[0].key}`, entries: tools });
    tools = null;
  };
  const pushTool = (entry: ToolEntry) => {
    if (!tools) tools = [];
    tools.push(entry);
  };

  for (const item of items) {
    if (item.kind === "prompt") {
      flushTools();
      rows.push({ kind: "prompt", key: item.id, text: item.text, ts: item.ts });
    } else if (item.kind === "result") {
      flushTools();
      rows.push({ kind: "result", key: item.id, isError: item.isError, costUsd: item.costUsd, durationMs: item.durationMs });
    } else if (item.kind === "error") {
      flushTools();
      rows.push({ kind: "error", key: item.id, message: item.message });
    } else {
      const ts = item.kind === "assistant" ? item.ts : undefined;
      item.content.forEach((block, i) => {
        const key = `${item.id}:${i}`;
        if (block.type === "text") {
          flushTools();
          rows.push({ kind: "text", key, text: block.text, ts });
        } else if (block.type === "thinking") {
          pushTool({ kind: "thinking", key, text: block.thinking });
        } else if (block.type === "tool_use") {
          pushTool({ kind: "use", key, name: block.name, input: block.input });
        } else if (block.type === "tool_result") {
          pushTool({ kind: "result", key, content: block.content, isError: block.isError });
        }
      });
    }
  }
  flushTools();
  return rows;
}

let itemCounter = 0;
function nextId() { return String(++itemCounter); }

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ClaudeUiTabHandle {
  reset: () => void;
}

interface ClaudeUiTabProps {
  sessionId: string;
  onTitleChange?: (title: string) => void;
  // Called when a turn completes (needs attention) / when the user sends a
  // message (attention cleared), to drive the pane title indicator.
  onAttention?: () => void;
  onClearAttention?: () => void;
  // Focus the input once on mount. Set only for freshly created sessions, so
  // re-attaching to an existing session (tab switch, page reload) doesn't steal
  // focus.
  autoFocus?: boolean;
}

const ClaudeUiTab = forwardRef<ClaudeUiTabHandle, ClaudeUiTabProps>(function ClaudeUiTab({ sessionId, onTitleChange, onAttention, onClearAttention, autoFocus }, ref) {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [permissionMode, setPermissionMode] = useState<ClaudeUiPermissionMode>("auto");
  const [model, setModel] = useState<ClaudeUiModel>("default");
  const [effort, setEffort] = useState<ClaudeUiEffort>("default");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasPromptRef = useRef(false);

  // Keep the latest onTitleChange in a ref so the subscription effect below can
  // call it without listing it as a dependency. The parent passes a fresh inline
  // closure on every render, and calling it updates parent state; if the effect
  // depended on it, each title update would tear down and re-create the
  // subscription (clearing + replaying the transcript), causing a render loop.
  const onTitleChangeRef = useRef(onTitleChange);
  useEffect(() => {
    onTitleChangeRef.current = onTitleChange;
  }, [onTitleChange]);

  // Same ref indirection as onTitleChange: the subscription effect must not
  // depend on this inline callback, or every attention update would tear down
  // and replay the subscription.
  const onAttentionRef = useRef(onAttention);
  useEffect(() => {
    onAttentionRef.current = onAttention;
  }, [onAttention]);

  // Attach to the (server-owned) session and replay its buffered transcript.
  // The session outlives this component, so we never create or close it here —
  // it survives tab switches and page reloads, like a terminal.
  useEffect(() => {
    let mounted = true;
    setItems([]);
    // Whether we've seen a prompt yet this attach; the first one provisionally
    // titles the pane. Tracked in a ref (not derived inside the setItems updater)
    // because a state updater must be pure — calling the parent's onTitleChange
    // from inside it updates TerminalStack while ClaudeUiTab is rendering.
    hasPromptRef.current = false;

    const unsubscribe = getRpcClient().subscribe(
      "claudeui.events",
      (event: ClaudeUiEvent) => {
        if (!mounted) return;

        if (event.type === "status") {
          setReady(event.ready);
          setBusy(event.busy);
          return;
        }
        if (event.type === "init") {
          setReady(true);
          return;
        }
        if (event.type === "title") {
          // Claude-generated title supersedes the provisional first-prompt title.
          onTitleChangeRef.current?.(event.title);
          return;
        }
        if (event.type === "prompt") {
          if (!hasPromptRef.current) {
            hasPromptRef.current = true;
            onTitleChangeRef.current?.(event.text.length > 60 ? event.text.slice(0, 60) + "..." : event.text);
          }
          setItems((prev) => [...prev, { kind: "prompt", id: nextId(), text: event.text, ts: event.ts }]);
        }
        if (event.type === "assistant" && event.content.length > 0) {
          setItems((prev) => [...prev, { kind: "assistant", id: nextId(), content: event.content, ts: event.ts }]);
        }
        if (event.type === "user" && event.content.length > 0) {
          setItems((prev) => [...prev, { kind: "tool_feedback", id: nextId(), content: event.content }]);
        }
        if (event.type === "result") {
          setItems((prev) => [...prev, { kind: "result", id: nextId(), isError: event.isError, costUsd: event.costUsd, durationMs: event.durationMs }]);
          onAttentionRef.current?.();
        }
        if (event.type === "error") {
          setItems((prev) => [...prev, { kind: "error", id: nextId(), message: event.message }]);
        }
      },
      { sessionId }
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [sessionId]);

  // Focus the input once when this tab is first created. Runs on mount only, so
  // re-attaching to an existing session doesn't steal focus.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    onClearAttention?.();
    // The prompt is rendered from the server's echoed "prompt" event so it
    // also replays on reconnect, rather than being added optimistically here.
    getRpcClient().query("claudeui.send", { sessionId, prompt: text }).catch((err) => {
      setItems((prev) => [...prev, { kind: "error", id: nextId(), message: String(err) }]);
    });
  }, [input, sessionId]);

  const interrupt = useCallback(() => {
    getRpcClient().query("claudeui.interrupt", { sessionId }).catch(() => {});
  }, [sessionId]);

  const changePermissionMode = useCallback((mode: ClaudeUiPermissionMode) => {
    setPermissionMode(mode);
    getRpcClient().query("claudeui.setPermissionMode", { sessionId, mode }).catch(() => {});
  }, [sessionId]);

  // Model/effort are spawn-time flags, so changing them respawns the CLI
  // resuming the same conversation (handled server-side).
  const changeModel = useCallback((next: ClaudeUiModel) => {
    setModel(next);
    getRpcClient().query("claudeui.setModelEffort", { sessionId, model: next, effort }).catch(() => {});
  }, [sessionId, effort]);

  const changeEffort = useCallback((next: ClaudeUiEffort) => {
    setEffort(next);
    getRpcClient().query("claudeui.setModelEffort", { sessionId, model, effort: next }).catch(() => {});
  }, [sessionId, model]);

  const reset = useCallback(() => {
    setItems([]);
    hasPromptRef.current = false;
    onTitleChange?.("");
    getRpcClient().query("claudeui.reset", { sessionId }).catch(() => {});
  }, [sessionId, onTitleChange]);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleReadlineEdit(e, setInput)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }, [send]);

  const canSend = !!sessionId && !busy && input.trim().length > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto min-h-0 text-sm" ref={scrollRef}>
        {items.length === 0 && (
          <div className="flex items-center justify-center h-full text-base-content/40 text-xs">
            {sessionId ? "Ready. Type a prompt below." : "Starting session..."}
          </div>
        )}
        {buildRows(items).map((row, idx, arr) => {
          if (row.kind === "prompt") {
            return (
              <div key={row.key} className="px-3 py-2 bg-base-200/50">
                <div className="whitespace-pre-wrap break-words">{row.text}</div>
                {row.ts !== undefined && (
                  <div className="text-[10px] leading-none text-base-content/30 mt-1">{formatTime(row.ts)}</div>
                )}
              </div>
            );
          }
          if (row.kind === "text") {
            return (
              <div key={row.key} className="group px-3 py-2">
                <MarkdownContent text={row.text} />
                <div className="flex items-center gap-2 mt-1">
                  {row.ts !== undefined && (
                    <span className="text-[10px] leading-none text-base-content/30">{formatTime(row.ts)}</span>
                  )}
                  <CopyButton text={row.text} />
                </div>
              </div>
            );
          }
          if (row.kind === "tools") {
            return <ToolGroup key={row.key} entries={row.entries} live={idx === arr.length - 1} />;
          }
          if (row.kind === "result") {
            const parts: string[] = [];
            if (row.durationMs !== undefined) parts.push(`${(row.durationMs / 1000).toFixed(1)}s`);
            if (row.costUsd !== undefined) parts.push(`$${row.costUsd.toFixed(4)}`);
            return (
              <div key={row.key} className={`px-3 py-1 text-xs opacity-40 border-b border-base-300 ${row.isError ? "text-error opacity-70" : ""}`}>
                {row.isError ? "Error" : "Done"}{parts.length > 0 ? ` - ${parts.join(" / ")}` : ""}
              </div>
            );
          }
          if (row.kind === "error") {
            return (
              <div key={row.key} className="px-3 py-2 flex gap-2 items-start text-error text-xs">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{row.message}</span>
              </div>
            );
          }
          return null;
        })}
        {busy && (
          <div className="px-3 py-2 flex items-center gap-2 text-xs text-base-content/40">
            <span className="loading loading-dots loading-xs" />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-base-300 bg-base-100 px-2 py-1.5">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs opacity-50">Permissions</span>
          <select
            className="select select-bordered select-xs font-mono"
            value={permissionMode}
            onChange={(e) => changePermissionMode(e.target.value as ClaudeUiPermissionMode)}
            disabled={!sessionId}
            title="Permission mode for this session"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <select
            className="select select-bordered select-xs font-mono"
            value={model}
            onChange={(e) => changeModel(e.target.value as ClaudeUiModel)}
            disabled={!sessionId}
            title="Model (respawns the session, resuming the conversation)"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <select
            className="select select-bordered select-xs font-mono"
            value={effort}
            onChange={(e) => changeEffort(e.target.value as ClaudeUiEffort)}
            disabled={!sessionId}
            title="Reasoning effort (respawns the session, resuming the conversation)"
          >
            {EFFORTS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-1.5 items-end">
          <textarea
            ref={textareaRef}
            className="textarea textarea-bordered textarea-sm flex-1 resize-none font-mono text-xs min-h-[2rem] max-h-32"
            placeholder={sessionId ? "Type a prompt... (Enter to send, Shift+Enter for newline)" : "Connecting..."}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!sessionId}
            rows={2}
          />
          <button
            className={`btn btn-sm px-3 ${busy ? "btn-ghost text-warning" : "btn-primary"}`}
            onClick={busy ? interrupt : send}
            disabled={!busy && !canSend}
            title={busy ? "Interrupt current turn" : "Send (Enter)"}
          >
            {busy ? "Stop" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default ClaudeUiTab;
