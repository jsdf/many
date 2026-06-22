import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { getRpcClient } from "../rpc-client";
import { Settings2, ChevronUp, ChevronDown, Check, X, AlertTriangle } from "lucide-react";
import type { ClaudeUiEvent, ClaudeUiContentBlock } from "../../../shared/protocol";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolUseBlock({ id, name, input }: { id: string; name: string; input: unknown }) {
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

function ContentBlockView({ block }: { block: ClaudeUiContentBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock id={block.id} name={block.name} input={block.input} />;
  }
  if (block.type === "tool_result") {
    return <ToolResultView content={block.content} isError={block.isError} />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display item types
// ---------------------------------------------------------------------------

type DisplayItem =
  | { kind: "prompt"; id: string; text: string }
  | { kind: "assistant"; id: string; content: ClaudeUiContentBlock[] }
  | { kind: "tool_feedback"; id: string; content: ClaudeUiContentBlock[] }
  | { kind: "result"; id: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: "error"; id: string; message: string };

let itemCounter = 0;
function nextId() { return String(++itemCounter); }

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ClaudeUiTabHandle {
  reset: () => void;
}

interface ClaudeUiTabProps {
  worktreePath: string;
  onTitleChange?: (title: string) => void;
}

const ClaudeUiTab = forwardRef<ClaudeUiTabHandle, ClaudeUiTabProps>(function ClaudeUiTab({ worktreePath, onTitleChange }, ref) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Create session on mount, subscribe to events
  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    let resolvedSessionId: string | null = null;

    getRpcClient().query("claudeui.create", { worktreePath }).then(({ sessionId }) => {
      if (!mounted) {
        // Component unmounted before session was created - clean it up
        getRpcClient().query("claudeui.close", { sessionId }).catch(() => {});
        return;
      }
      resolvedSessionId = sessionId;
      setSessionId(sessionId);

      unsubscribe = getRpcClient().subscribe(
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
          if (event.type === "assistant" && event.content.length > 0) {
            setItems((prev) => [...prev, { kind: "assistant", id: nextId(), content: event.content }]);
          }
          if (event.type === "user" && event.content.length > 0) {
            setItems((prev) => [...prev, { kind: "tool_feedback", id: nextId(), content: event.content }]);
          }
          if (event.type === "result") {
            setItems((prev) => [...prev, { kind: "result", id: nextId(), isError: event.isError, costUsd: event.costUsd, durationMs: event.durationMs }]);
          }
          if (event.type === "error") {
            setItems((prev) => [...prev, { kind: "error", id: nextId(), message: event.message }]);
          }
        },
        { sessionId }
      );
    }).catch((err) => {
      if (mounted) {
        setItems([{ kind: "error", id: nextId(), message: String(err) }]);
      }
    });

    return () => {
      mounted = false;
      unsubscribe?.();
      if (resolvedSessionId) {
        getRpcClient().query("claudeui.close", { sessionId: resolvedSessionId }).catch(() => {});
      }
    };
  }, [worktreePath]);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || !sessionId) return;
    setInput("");
    setItems((prev) => {
      if (prev.filter((i) => i.kind === "prompt").length === 0) {
        onTitleChange?.(text.length > 60 ? text.slice(0, 60) + "..." : text);
      }
      return [...prev, { kind: "prompt", id: nextId(), text }];
    });
    getRpcClient().query("claudeui.send", { sessionId, prompt: text }).catch((err) => {
      setItems((prev) => [...prev, { kind: "error", id: nextId(), message: String(err) }]);
    });
  }, [input, sessionId, onTitleChange]);

  const interrupt = useCallback(() => {
    if (!sessionId) return;
    getRpcClient().query("claudeui.interrupt", { sessionId }).catch(() => {});
  }, [sessionId]);

  const reset = useCallback(() => {
    if (!sessionId) return;
    setItems([]);
    onTitleChange?.("");
    getRpcClient().query("claudeui.reset", { sessionId }).catch(() => {});
  }, [sessionId, onTitleChange]);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        {items.map((item) => {
          if (item.kind === "prompt") {
            return (
              <div key={item.id} className="px-3 py-2 bg-base-200/50">
                <div className="text-xs opacity-50 text-primary mb-0.5">You</div>
                <div className="whitespace-pre-wrap break-words">{item.text}</div>
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div key={item.id} className="px-3 py-2">
                <div className="text-xs opacity-50 text-secondary mb-0.5">Claude</div>
                {item.content.map((block, i) => (
                  <ContentBlockView key={i} block={block} />
                ))}
              </div>
            );
          }
          if (item.kind === "tool_feedback") {
            return (
              <div key={item.id} className="px-3 py-1">
                {item.content.map((block, i) => (
                  <ContentBlockView key={i} block={block} />
                ))}
              </div>
            );
          }
          if (item.kind === "result") {
            const parts: string[] = [];
            if (item.durationMs !== undefined) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
            if (item.costUsd !== undefined) parts.push(`$${item.costUsd.toFixed(4)}`);
            return (
              <div key={item.id} className={`px-3 py-1 text-xs opacity-40 border-b border-base-300 ${item.isError ? "text-error opacity-70" : ""}`}>
                {item.isError ? "Error" : "Done"}{parts.length > 0 ? ` - ${parts.join(" / ")}` : ""}
              </div>
            );
          }
          if (item.kind === "error") {
            return (
              <div key={item.id} className="px-3 py-2 flex gap-2 items-start text-error text-xs">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{item.message}</span>
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
