import React, { useState, useCallback, useEffect } from "react";
import { getRpcClient } from "../rpc-client.js";
import { useSessionMessages } from "../hooks.js";
import { MessageList } from "./MessageList.js";
import { SessionInput } from "./SessionInput.js";
import { PermissionBanner } from "./PermissionBanner.js";
import type { SessionStatus } from "../../shared/protocol.js";

const PERMISSION_MODES: { value: string; label: string }[] = [
  { value: "bypassPermissions", label: "Bypass (trust all)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "default", label: "Default (ask)" },
  { value: "plan", label: "Plan only" },
];

/**
 * Standalone Claude session view.
 *
 * Props:
 * - sessionId: if provided, loads that session (read-only until activated)
 * - cwd: working directory for new sessions
 */
export function ClaudeSessionView({
  sessionId: initialSessionId,
  cwd,
}: {
  sessionId?: string | null;
  cwd: string;
}) {
  const [sessionId, setSessionId] = useState<string | null>(
    initialSessionId ?? null
  );
  const [isActive, setIsActive] = useState(false);
  const [permissionMode, setPermissionMode] = useState("bypassPermissions");
  const [startPrompt, setStartPrompt] = useState("");
  const [starting, setStarting] = useState(false);

  const { messages, status, permissionRequest, result } = useSessionMessages(
    sessionId,
    { dir: cwd }
  );

  // Shift+Tab to cycle permission mode (matching Claude Code's shortcut)
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

  // Start a new session
  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const client = getRpcClient();
      const res = await client.query("session.start", {
        cwd,
        prompt: startPrompt || undefined,
        permissionMode,
      });
      setSessionId(res.sessionId);
      setIsActive(true);
      setStartPrompt("");
    } catch (err) {
      console.error("Failed to start session:", err);
    } finally {
      setStarting(false);
    }
  }, [cwd, startPrompt, permissionMode]);

  // Activate an existing (read-only) session by resuming it
  const handleActivate = useCallback(async () => {
    if (!sessionId) return;
    setStarting(true);
    try {
      const client = getRpcClient();
      await client.query("session.start", {
        cwd,
        sessionId,
        permissionMode,
      });
      setIsActive(true);
    } catch (err) {
      console.error("Failed to activate session:", err);
    } finally {
      setStarting(false);
    }
  }, [sessionId, cwd, permissionMode]);

  // Send a message
  const handleSend = useCallback(
    async (message: string) => {
      if (!sessionId) return;
      try {
        const client = getRpcClient();
        await client.query("session.send", { sessionId, message });
      } catch (err) {
        console.error("Failed to send:", err);
      }
    },
    [sessionId]
  );

  // Permission response
  const handlePermission = useCallback(
    async (allow: boolean) => {
      if (!sessionId || !permissionRequest) return;
      try {
        const client = getRpcClient();
        await client.query("session.permission", {
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

  // Interrupt
  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return;
    const client = getRpcClient();
    await client.query("session.interrupt", { sessionId });
  }, [sessionId]);

  const currentModeLabel =
    PERMISSION_MODES.find((m) => m.value === permissionMode)?.label ??
    permissionMode;

  // ----- No session: show start screen -----
  if (!sessionId) {
    return (
      <div className="flex flex-col h-full bg-base-100">
        <Header
          status="idle"
          permissionMode={currentModeLabel}
          onInterrupt={handleInterrupt}
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col gap-3 w-full max-w-lg p-6">
            <h2 className="text-lg font-semibold text-base-content/80">
              New Claude Session
            </h2>
            <p className="text-sm text-base-content/50">
              Working directory: <code className="text-xs">{cwd}</code>
            </p>
            <textarea
              className="textarea textarea-bordered w-full min-h-[80px] text-sm"
              placeholder="Initial prompt (optional)"
              value={startPrompt}
              onChange={(e) => setStartPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleStart();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleStart}
                disabled={starting}
              >
                {starting ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  "Start Session"
                )}
              </button>
              <span className="text-xs text-base-content/40">
                {currentModeLabel} · Shift+Tab to cycle
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ----- Has session -----
  return (
    <div className="flex flex-col h-full bg-base-100">
      <Header
        status={status}
        permissionMode={currentModeLabel}
        sessionId={sessionId}
        isActive={isActive}
        onActivate={handleActivate}
        onInterrupt={handleInterrupt}
        activating={starting}
      />

      <MessageList messages={messages} />

      {/* Permission banner when waiting */}
      {permissionRequest && (
        <PermissionBanner
          request={permissionRequest}
          onRespond={handlePermission}
        />
      )}

      {/* Result banner */}
      {result && (
        <div
          className={`border-t px-3 py-2 text-xs flex gap-4 ${
            result.isError
              ? "border-error/30 bg-error/10 text-error"
              : "border-success/30 bg-success/10 text-success"
          }`}
        >
          <span>{result.isError ? "Failed" : "Done"}</span>
          <span>{result.numTurns} turns</span>
          <span>{(result.durationMs / 1000).toFixed(1)}s</span>
          <span>${result.totalCostUsd.toFixed(4)}</span>
        </div>
      )}

      {/* Input area */}
      <SessionInput onSend={handleSend} disabled={!isActive} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header bar
// ---------------------------------------------------------------------------

function Header({
  status,
  permissionMode,
  sessionId,
  isActive,
  onActivate,
  onInterrupt,
  activating,
}: {
  status: SessionStatus;
  permissionMode: string;
  sessionId?: string;
  isActive?: boolean;
  onActivate?: () => void;
  onInterrupt: () => void;
  activating?: boolean;
}) {
  const statusColors: Record<string, string> = {
    idle: "badge-ghost",
    running: "badge-success",
    waiting_permission: "badge-warning",
    compacting: "badge-info",
    error: "badge-error",
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-200/50 min-h-[40px]">
      <div className={`badge badge-xs ${statusColors[status] ?? "badge-ghost"}`}>
        {status}
      </div>

      <span className="text-xs text-base-content/40">{permissionMode}</span>

      <div className="flex-1" />

      {sessionId && !isActive && onActivate && (
        <button
          className="btn btn-xs btn-primary"
          onClick={onActivate}
          disabled={activating}
        >
          {activating ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            "Activate"
          )}
        </button>
      )}

      {isActive && status === "running" && (
        <button className="btn btn-xs btn-ghost" onClick={onInterrupt}>
          Interrupt
        </button>
      )}

      {sessionId && (
        <span className="text-xs text-base-content/20 font-mono">
          {sessionId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}
