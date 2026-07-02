import React, { useState, useCallback, useEffect, useRef } from "react";
import { getRpcClient } from "../rpc-client";
import { handleReadlineEdit } from "../readline-edit";
import { Settings2, Check, X, ChevronUp, ChevronDown, Brain, AlertTriangle } from "lucide-react";
import type {
  SessionMessage,
  SessionStatus,
  SessionEvent,
  ContentBlock,
  ToolUse,
  ToolResult,
  PermissionRequest,
  SessionResult,
} from "../../../shared/protocol";

// ---------------------------------------------------------------------------
// Permission modes (Shift+Tab cycles)
// ---------------------------------------------------------------------------

const PERMISSION_MODES = [
  { value: "bypassPermissions", label: "Bypass" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "default", label: "Ask" },
  { value: "plan", label: "Plan" },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCallPill({ toolUse }: { toolUse: ToolUse }) {
  const [open, setOpen] = useState(false);
  const preview =
    (toolUse.input as any).command ??
    (toolUse.input as any).file_path ??
    (toolUse.input as any).pattern ??
    (toolUse.input as any).path ??
    (toolUse.input as any).description ??
    "";
  const text = typeof preview === "string" && preview.length > 80 ? preview.slice(0, 80) + "…" : String(preview);

  return (
    <div className="my-0.5">
      <button className="btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
        <span className="text-accent"><Settings2 size={12} /></span>
        <span>{toolUse.name}</span>
        {text && <span className="opacity-50 max-w-[300px] truncate">{text}</span>}
        <span className="opacity-40">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
          {JSON.stringify(toolUse.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({ toolResult }: { toolResult: ToolResult }) {
  const [open, setOpen] = useState(false);
  const truncated = toolResult.output.length > 200 ? toolResult.output.slice(0, 200) + "…" : toolResult.output;

  return (
    <div className="my-0.5">
      <button
        className={`btn btn-xs btn-ghost gap-1 font-mono text-xs opacity-70 hover:opacity-100 ${toolResult.isError ? "text-error" : "text-success"}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{toolResult.isError ? <X size={12} /> : <Check size={12} />}</span>
        <span className="opacity-50 max-w-[400px] truncate">{truncated}</span>
        {toolResult.output.length > 200 && <span className="opacity-40">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>}
      </button>
      {open && (
        <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">
          {toolResult.output}
        </pre>
      )}
    </div>
  );
}

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") return <div className="whitespace-pre-wrap break-words">{block.text}</div>;
  if (block.type === "thinking") {
    const [open, setOpen] = useState(false);
    return (
      <div className="my-0.5">
        <button className="btn btn-xs btn-ghost gap-1 text-xs text-base-content/50 opacity-70 hover:opacity-100" onClick={() => setOpen((o) => !o)}>
          <span><Brain size={12} /></span><span>thinking</span><span className="opacity-40">{open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</span>
        </button>
        {open && <pre className="mt-1 p-2 bg-base-300 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap opacity-70">{block.thinking}</pre>}
      </div>
    );
  }
  if (block.type === "tool_use") return <ToolCallPill toolUse={block.toolUse} />;
  if (block.type === "tool_result") return <ToolResultBlock toolResult={block.toolResult} />;
  return null;
}

function ChatMessage({ message }: { message: SessionMessage }) {
  const isUser = message.role === "user";
  // For user messages, only show text content (tool_result blocks are internal protocol
  // plumbing for tool call responses — they shouldn't appear as user-visible messages)
  const hasContent = isUser
    ? message.content.some((b) => b.type === "text")
    : message.content.some((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_use" || b.type === "tool_result");
  if (!hasContent) return null;

  return (
    <div className={`flex flex-col gap-0.5 px-3 py-2 ${isUser ? "bg-base-200/50" : ""}`}>
      <div className="flex items-center gap-2 text-xs opacity-50 mb-0.5">
        <span className={isUser ? "text-primary" : "text-secondary"}>
          {isUser ? "You" : message.role === "system" ? "System" : "Claude"}
        </span>
      </div>
      <div className="text-sm">
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>
      {message.error && <div className="text-xs text-error mt-1">Error: {message.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ClaudeSessionTabProps {
  worktreePath: string;
  sessionId?: string;
}

export default function ClaudeSessionTab({ worktreePath, sessionId: initialSessionId }: ClaudeSessionTabProps) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [permissionMode, setPermissionMode] = useState("bypassPermissions");
  const [inputText, setInputText] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (shouldScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    shouldScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  // Shift+Tab to cycle permission mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        setPermissionMode((prev) => {
          const idx = PERMISSION_MODES.findIndex((m) => m.value === prev);
          return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length].value;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Load historical messages for existing session
  useEffect(() => {
    if (!initialSessionId) return;
    getRpcClient()
      .query("session.messages", { sessionId: initialSessionId, dir: worktreePath })
      .then((res) => setMessages(res.messages))
      .catch(() => {});
  }, [initialSessionId, worktreePath]);

  // Subscribe to live events when session is active
  useEffect(() => {
    if (!sessionId || !isActive) return;

    const unsubscribe = getRpcClient().subscribe(
      "session.events",
      (event: SessionEvent) => {
        switch (event.type) {
          case "message":
            setMessages((prev) => {
              if (event.message.role === "user") {
                // Skip user messages that only contain tool_results — these are internal
                // protocol messages (tool call responses), not user-typed text.
                const hasText = event.message.content.some((b) => b.type === "text");
                if (!hasText) return prev;

                // Deduplicate against the last user message we added optimistically.
                // Search backwards past any non-user messages (e.g. tool_result messages
                // that may have been interleaved) to find the most recent user message.
                const lastUserMsg = [...prev].reverse().find((m) => m.role === "user");
                if (lastUserMsg) {
                  const lastText = lastUserMsg.content.find((b) => b.type === "text");
                  const newText = event.message.content.find((b) => b.type === "text");
                  if (lastText && newText && lastText.type === "text" && newText.type === "text" && lastText.text === newText.text) {
                    return prev; // skip duplicate
                  }
                }
              }
              return [...prev, event.message];
            });
            break;
          case "status":
            setStatus(event.status);
            break;
          case "permission_request":
            setPermissionRequest(event.request);
            break;
          case "permission_resolved":
            setPermissionRequest(null);
            break;
          case "result":
            setResult(event.result);
            break;
        }
      },
      { sessionId }
    );

    return unsubscribe;
  }, [sessionId, isActive]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    const promptText = inputText.trim();
    try {
      const res = await getRpcClient().query("session.start", {
        cwd: worktreePath,
        prompt: promptText || undefined,
        permissionMode,
      });
      // Show the initial prompt as a user message immediately (optimistic)
      if (promptText) {
        setMessages([{
          id: crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        }]);
      }
      setSessionId(res.sessionId);
      setIsActive(true);
      setInputText("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to start session:", msg);
      setStartError(msg);
    } finally {
      setStarting(false);
    }
  }, [worktreePath, inputText, permissionMode]);

  const handleActivate = useCallback(async () => {
    if (!sessionId) return;
    setStarting(true);
    try {
      await getRpcClient().query("session.start", {
        cwd: worktreePath,
        sessionId,
        permissionMode,
      });
      setIsActive(true);
    } catch (err) {
      console.error("Failed to activate session:", err);
    } finally {
      setStarting(false);
    }
  }, [sessionId, worktreePath, permissionMode]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !sessionId) return;
    setInputText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setResult(null);

    // Optimistically add user message to chat
    const userMsg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      await getRpcClient().query("session.send", { sessionId, message: text });
    } catch (err) {
      console.error("Failed to send:", err);
    }
  }, [sessionId, inputText]);

  const handlePermission = useCallback(
    async (allow: boolean) => {
      if (!sessionId || !permissionRequest) return;
      try {
        await getRpcClient().query("session.permission", {
          sessionId,
          requestId: permissionRequest.requestId,
          allow,
        });
      } catch (err) {
        console.error("Failed to respond to permission:", err);
      }
    },
    [sessionId, permissionRequest]
  );

  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return;
    await getRpcClient().query("session.interrupt", { sessionId });
  }, [sessionId]);

  const currentModeLabel = PERMISSION_MODES.find((m) => m.value === permissionMode)?.label ?? permissionMode;

  const statusColors: Record<string, string> = {
    idle: "badge-ghost",
    running: "badge-success",
    waiting_permission: "badge-warning",
    compacting: "badge-info",
    error: "badge-error",
  };

  // ----- No session: start prompt -----
  if (!sessionId) {
    return (
      <div className="flex flex-col h-full bg-base-100">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col gap-3 w-full max-w-lg p-6">
            <textarea
              ref={textareaRef}
              autoFocus
              className="textarea textarea-bordered w-full min-h-[60px] text-sm"
              placeholder="Initial prompt (optional)"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (handleReadlineEdit(e, setInputText)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleStart();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <button className="btn btn-outline btn-primary btn-sm" onClick={handleStart} disabled={starting}>
                {starting ? <span className="loading loading-spinner loading-xs" /> : "Start"}
              </button>
              <span className="text-xs text-base-content/40">{currentModeLabel} · Shift+Tab</span>
            </div>
            {startError && (
              <div className="text-xs text-error mt-1">{startError}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ----- Has session -----
  return (
    <div className="flex flex-col h-full bg-base-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-base-300 bg-base-200/50 shrink-0">
        <div className={`badge badge-xs ${statusColors[status] ?? "badge-ghost"}`}>{status}</div>
        <span className="text-xs text-base-content/40">{currentModeLabel}</span>
        <div className="flex-1" />
        {!isActive && !result && (
          <button className="btn btn-xs btn-outline btn-primary" onClick={handleActivate} disabled={starting}>
            {starting ? <span className="loading loading-spinner loading-xs" /> : "Activate"}
          </button>
        )}
        {status === "running" && (
          <button className="btn btn-xs btn-ghost" onClick={handleInterrupt}>Interrupt</button>
        )}
        <span className="text-xs text-base-content/20 font-mono">{sessionId.slice(0, 8)}</span>
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-base-content/30 text-sm">No messages yet</div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Permission banner */}
      {permissionRequest && (
        <div className="border-t border-warning/30 bg-warning/10 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-amber-600"><AlertTriangle size={14} /></span>
            <span className="font-medium">{permissionRequest.displayName ?? permissionRequest.toolName}</span>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-sm btn-outline btn-success" onClick={() => handlePermission(true)}>Allow</button>
            <button className="btn btn-sm btn-error btn-outline" onClick={() => handlePermission(false)}>Deny</button>
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div className={`border-t px-3 py-2 text-xs flex gap-4 ${result.isError ? "border-error/30 bg-error/10 text-error" : "border-success/30 bg-success/10 text-success"}`}>
          <span>{result.isError ? "Failed" : "Done"}</span>
          <span>{result.numTurns} turns</span>
          <span>{(result.durationMs / 1000).toFixed(1)}s</span>
          <span>${result.totalCostUsd.toFixed(4)}</span>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-base-300 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            autoFocus
            className="textarea textarea-bordered flex-1 min-h-[40px] max-h-[200px] resize-none text-sm leading-relaxed"
            placeholder={isActive ? "Send a message…" : "Session not active"}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 200) + "px";
            }}
            onKeyDown={(e) => {
              if (
                handleReadlineEdit(e, (v) => {
                  setInputText(v);
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 200) + "px";
                })
              )
                return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button className="btn btn-outline btn-primary btn-sm" onClick={handleSend} disabled={!inputText.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
