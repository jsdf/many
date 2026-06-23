import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { Maximize2, Minimize2, Pencil, X } from "lucide-react";
import { getRpcClient } from "../rpc-client";
import TerminalTab from "./TerminalTab";
import TaskLogTab from "./TaskLogTab";
import SessionHistoryTab from "./SessionHistoryTab";
import ClaudeSessionTab from "./ClaudeSessionTab";
import ClaudeUiTab, { type ClaudeUiTabHandle } from "./ClaudeUiTab";
import { setFocusedTerminal, useFocusedTerminal } from "../focused-terminal";

interface TerminalStackProps {
  worktreePath: string;
  repoPath?: string;
  claudeCommand?: string;
  fixedTerminalHeight?: number;
}

export interface TerminalStackHandle {
  createTerminalWithCommand: (env: Record<string, string>, initialCommand: string, taskId?: string) => void;
  openSessionHistory: (sessionId: string) => void;
  openTaskLog: (taskId: string, isSavedLog?: boolean) => void;
  openClaudeSession: (sessionId?: string) => void;
  resumeClaudeCodeSession: (sessionId: string, command: string) => void;
  openClaudeUiSession: () => void;
}

interface TerminalInfo {
  id: string;
  env?: Record<string, string>;
  initialCommand?: string;
  taskId?: string;
  isTaskLog?: boolean; // read-only log tab for a CLI-launched task
  isSavedLog?: boolean; // saved terminal session from shutdown
  isSessionHistory?: boolean;
  sessionId?: string;
  isClaudeSession?: boolean;
  isClaudeUi?: boolean;
  resumeSessionId?: string; // claude-code session this terminal was opened to resume
}

let terminalCounter = 0;

const TerminalStack = forwardRef<TerminalStackHandle, TerminalStackProps>(({ worktreePath, repoPath, claudeCommand, fixedTerminalHeight }, ref) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [sizes, setSizes] = useState<number[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [terminalTitles, setTerminalTitles] = useState<Record<string, string>>({});
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const focusedId = useFocusedTerminal();

  const toggleMaximize = useCallback((terminalId: string) => {
    setMaximizedId((prev) => (prev === terminalId ? null : terminalId));
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ divider: HTMLElement; dividerIndex: number } | null>(null);
  const claudeUiRefs = useRef<Map<string, ClaudeUiTabHandle>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const loadExisting = async () => {
      const tabs: TerminalInfo[] = [];

      try {
        const sessions = await getRpcClient().query("terminal.listSessions", { worktreePath });
        if (cancelled) return;
        const labels: Record<string, string> = {};
        for (const { id, userLabel, taskId } of sessions) {
          if (!id) continue; // skip corrupt sessions with no id (would collide as duplicate keys)
          tabs.push({ id, taskId });
          if (userLabel) labels[id] = userLabel;
        }
        if (Object.keys(labels).length > 0) setUserLabels((prev) => ({ ...prev, ...labels }));
      } catch (err) {
        console.error("Failed to load terminal sessions:", err);
      }

      try {
        const sessions = await getRpcClient().query("claude.sessions", { worktreePath }) as any[];
        if (cancelled) return;
        for (const s of sessions) {
          // Only auto-reopen sessions that are running, were created as chat sessions, and not explicitly closed
          if (s.isRunning && s.sessionType === "chat" && !s.closed) {
            tabs.push({ id: `claude-session-${s.sessionId}`, isClaudeSession: true, sessionId: s.sessionId });
          }
        }
      } catch {}

      try {
        // Re-attach to live Claude UI sessions (server-owned, survive tab switches).
        const sessions = await getRpcClient().query("claudeui.list", { worktreePath });
        if (cancelled) return;
        const titles: Record<string, string> = {};
        for (const { sessionId, title } of sessions) {
          const id = `claude-ui-${sessionId}`;
          tabs.push({ id, isClaudeUi: true, sessionId });
          if (title) titles[id] = title;
        }
        if (Object.keys(titles).length > 0) setTerminalTitles((prev) => ({ ...prev, ...titles }));
      } catch {}

      if (!cancelled && tabs.length > 0) {
        setTerminals(tabs);
        setSizes(tabs.map(() => 1 / tabs.length));
      }
    };

    loadExisting();
    return () => { cancelled = true; };
  }, [worktreePath]);

  // Keep sizes a valid, length-matched, sum-1 array. Heals any stale/corrupted
  // state (wrong length, non-finite values, or drifted sum) without a reload.
  useEffect(() => {
    if (terminals.length === 0) return;
    setSizes((prev) => {
      if (prev.length !== terminals.length || prev.some((n) => !Number.isFinite(n) || n <= 0)) {
        return terminals.map(() => 1 / terminals.length);
      }
      const sum = prev.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) < 1e-6) return prev;
      return prev.map((n) => n / sum);
    });
  }, [terminals.length]);

  // Check for running tasks without an owning terminal (e.g. CLI-launched tasks)
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;

    const checkForOrphanTasks = async () => {
      try {
        const tasks = await getRpcClient().query("task.list", { repoPath });
        // Show running tasks (CLI-launched) — saved logs are opened on demand via "View Log" button
        const runningTasksForWorktree = tasks.filter(
          (t: any) => t.worktreePath === worktreePath && t.logFile && t.status === "running"
        );

        if (cancelled || runningTasksForWorktree.length === 0) return;

        setTerminals((prev) => {
          // Don't add if we already have a tab for this task
          const existingTaskIds = new Set(prev.filter((t) => t.taskId).map((t) => t.taskId));
          const newTabs = runningTasksForWorktree
            .filter((t: any) => !existingTaskIds.has(t.id))
            .map((t: any) => ({
              id: `task-log-${t.id}`,
              taskId: t.id,
              isTaskLog: true,
              isSavedLog: t.status !== "running",
            }));

          if (newTabs.length === 0) return prev;
          const next = [...prev, ...newTabs];
          setSizes(next.map(() => 1 / next.length));
          return next;
        });
      } catch {
        // ignore
      }
    };

    checkForOrphanTasks();
    return () => { cancelled = true; };
  }, [worktreePath, repoPath]);

  const addTerminal = useCallback((env?: Record<string, string>, initialCommand?: string, taskId?: string) => {
    terminalCounter++;
    const id = `${worktreePath}-term-${Date.now()}-${terminalCounter}`;
    setTerminals((prev) => {
      const next = [...prev, { id, env, initialCommand, taskId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, [worktreePath]);

  const createTerminal = useCallback(() => {
    addTerminal();
  }, [addTerminal]);

  const openTaskLog = useCallback((taskId: string, isSavedLog?: boolean) => {
    setTerminals((prev) => {
      if (prev.some((t) => t.taskId === taskId)) return prev;
      const id = `task-log-${taskId}`;
      const next = [...prev, { id, taskId, isTaskLog: true, isSavedLog: !!isSavedLog }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, []);

  const openSessionHistory = useCallback((sessionId: string) => {
    // Don't open duplicate tabs for the same session
    setTerminals((prev) => {
      if (prev.some((t) => t.sessionId === sessionId && t.isSessionHistory)) return prev;
      terminalCounter++;
      const id = `session-history-${sessionId}`;
      const next = [...prev, { id, isSessionHistory: true, sessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, []);

  const openClaudeSession = useCallback((sessionId?: string) => {
    setTerminals((prev) => {
      // Don't duplicate if resuming same session
      if (sessionId && prev.some((t) => t.sessionId === sessionId && t.isClaudeSession)) return prev;
      terminalCounter++;
      const id = sessionId ? `claude-session-${sessionId}` : `claude-session-new-${Date.now()}`;
      const next = [...prev, { id, isClaudeSession: true, sessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, []);

  const resumeClaudeCodeSession = useCallback((sessionId: string, command: string) => {
    setTerminals((prev) => {
      // Don't open a duplicate pane when this session is already being resumed.
      if (prev.some((t) => t.resumeSessionId === sessionId)) return prev;
      terminalCounter++;
      const id = `claude-resume-${sessionId}`;
      const next = [...prev, { id, initialCommand: command, resumeSessionId: sessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, []);

  const openClaudeUiSession = useCallback(async () => {
    // The session is server-owned (it outlives the tab), so create it first and
    // key the tab on its id. Restoring on return uses the same id, so a returning
    // tab re-attaches to the live session instead of spawning a duplicate.
    const { sessionId } = await getRpcClient().query("claudeui.create", { worktreePath });
    setTerminals((prev) => {
      const id = `claude-ui-${sessionId}`;
      const next = [...prev, { id, isClaudeUi: true, sessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, [worktreePath]);

  useImperativeHandle(ref, () => ({
    createTerminalWithCommand: (env: Record<string, string>, initialCommand: string, taskId?: string) => {
      addTerminal(env, initialCommand, taskId);
    },
    openSessionHistory,
    openClaudeSession,
    resumeClaudeCodeSession,
    openClaudeUiSession,
    openTaskLog,
  }), [addTerminal, openSessionHistory, openTaskLog, openClaudeSession, resumeClaudeCodeSession, openClaudeUiSession]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const term = terminals.find((t) => t.id === terminalId);
      if (term?.isClaudeSession && term.sessionId) {
        try {
          await getRpcClient().query("session.close", { sessionId: term.sessionId });
        } catch {
          // Session may already be dead
        }
      } else if (term?.isClaudeUi && term.sessionId) {
        try {
          await getRpcClient().query("claudeui.close", { sessionId: term.sessionId });
        } catch {
          // Session may already be dead
        }
      } else if (term?.isTaskLog && term.taskId && !term.isSavedLog) {
        try {
          await getRpcClient().query("task.kill", { taskId: term.taskId });
        } catch {
          // Task may already be dead
        }
      } else if (!term?.isTaskLog && !term?.isSessionHistory && !term?.isClaudeUi) {
        try {
          await getRpcClient().query("terminal.close", { terminalId });
        } catch {
          // Session may already be dead
        }
      }
      setMaximizedId((prev) => (prev === terminalId ? null : prev));
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== terminalId);
        if (next.length > 0) {
          setSizes(next.map(() => 1 / next.length));
        } else {
          setSizes([]);
        }
        return next;
      });
    },
    [terminals]
  );

  const handleMouseDown = useCallback(
    (dividerIndex: number, e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { divider: e.currentTarget as HTMLElement, dividerIndex };
      setDragging(dividerIndex);
    },
    []
  );

  useEffect(() => {
    if (dragging === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const info = dragRef.current;
      if (!info) return;
      const paneA = info.divider.previousElementSibling as HTMLElement | null;
      const paneB = info.divider.nextElementSibling as HTMLElement | null;
      if (!paneA || !paneB) return;

      // Derive the split from actual rendered pixel heights so the divider tracks
      // the cursor exactly, regardless of header/divider chrome or stale sizes.
      const aRect = paneA.getBoundingClientRect();
      const bRect = paneB.getBoundingClientRect();
      const totalPx = aRect.height + bRect.height;
      const minPx = Math.min(60, totalPx / 2);
      const newApx = Math.max(minPx, Math.min(totalPx - minPx, e.clientY - aRect.top));
      const ratio = newApx / totalPx;

      setSizes((prev) => {
        const next = [...prev];
        const d = info.dividerIndex;
        const pairSize = (next[d] ?? 0) + (next[d + 1] ?? 0);
        next[d] = pairSize * ratio;
        next[d + 1] = pairSize * (1 - ratio);
        return next;
      });
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      setDragging(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  const hasTerminals = terminals.length > 0;

  return (
    <div className={`flex flex-col ${fixedTerminalHeight ? '' : 'h-full overflow-hidden'}`}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-base-100 border-b border-base-300 shrink-0">
        <span className="text-sm text-base-content/60 font-medium">Terminals</span>
        <div className="flex gap-1">
          <button className="btn btn-outline btn-neutral btn-xs" onClick={openClaudeUiSession}>
            + Claude UI
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={() => openClaudeSession()}>
            + Chat
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={() => addTerminal(undefined, claudeCommand || 'claude')}>
            + Claude Code
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={createTerminal}>
            + New
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className={`flex-1 flex flex-col ${fixedTerminalHeight ? '' : 'overflow-hidden'} min-h-0`}
        style={{ userSelect: dragging !== null ? "none" : undefined }}
      >
        {!hasTerminals && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-base-content/60" style={fixedTerminalHeight ? { height: fixedTerminalHeight } : undefined}>
            <p>No terminals open</p>
            <div className="flex gap-2">
              <button className="btn btn-outline btn-neutral" onClick={() => addTerminal(undefined, claudeCommand || 'claude')}>
                + Claude Code
              </button>
              <button className="btn btn-outline btn-neutral" onClick={createTerminal}>
                + New Terminal
              </button>
            </div>
          </div>
        )}
        {terminals.map((term, i) => {
          const isMaximized = maximizedId !== null && maximizedId === term.id;
          const isCollapsed = maximizedId !== null && !isMaximized;
          const isFocused = focusedId === term.id;
          return (
          <React.Fragment key={term.id}>
            {i > 0 && !fixedTerminalHeight && !maximizedId && (
              <div
                className={`h-1 shrink-0 cursor-ns-resize transition-colors ${dragging === i - 1 ? 'bg-primary' : 'bg-base-300 hover:bg-primary'}`}
                onMouseDown={(e) => handleMouseDown(i - 1, e)}
              />
            )}
            <div
              className={`flex flex-col overflow-hidden ${fixedTerminalHeight ? '' : isCollapsed ? '' : 'min-h-[60px]'}`}
              style={fixedTerminalHeight
                ? { height: fixedTerminalHeight }
                : isMaximized
                  ? { flex: '1 0 0', minHeight: 0 }
                  : isCollapsed
                    ? { flex: '0 0 auto' }
                    : { flex: `${sizes[i] ?? 1 / terminals.length} 0 0`, minHeight: 0 }
              }
              onMouseDown={() => setFocusedTerminal(term.id)}
              onFocus={() => setFocusedTerminal(term.id)}
            >
              <div className={`group flex items-center justify-between px-2.5 py-[3px] border-b shrink-0 ${isFocused ? 'bg-base-content border-base-content' : 'bg-base-100 border-base-300'}`}>
                {(() => {
                  const isRenameable = !term.isTaskLog && !term.isSavedLog && !term.isSessionHistory && !term.isClaudeSession;
                  const dynamicTitle = terminalTitles[term.id];
                  const userLabel = userLabels[term.id];
                  let displayTitle: string;
                  if (term.isClaudeSession) displayTitle = "Claude Session";
                  else if (term.isSessionHistory) displayTitle = "Session History";
                  else if (term.isSavedLog) displayTitle = "Saved Log (read-only)";
                  else if (term.isTaskLog) displayTitle = "Task Log (read-only)";
                  else if (userLabel) displayTitle = dynamicTitle ? `${userLabel} | ${dynamicTitle}` : userLabel;
                  else if (term.isClaudeUi) displayTitle = dynamicTitle ? `Claude UI: ${dynamicTitle}` : "Claude UI";
                  else displayTitle = dynamicTitle ? `Terminal ${i + 1}: ${dynamicTitle}` : `Terminal ${i + 1}`;

                  if (editingId !== null && editingId === term.id) {
                    return (
                      <input
                        autoFocus
                        className="text-xs bg-transparent border border-primary rounded px-1 outline-none text-base-content min-w-0 flex-1 mr-2"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const label = editValue.trim();
                            getRpcClient().query("terminal.setLabel", { terminalId: term.id, label });
                            setUserLabels((prev) => label
                              ? { ...prev, [term.id]: label }
                              : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== term.id)));
                            setEditingId(null);
                          } else if (e.key === "Escape") {
                            setEditingId(null);
                          }
                        }}
                        onBlur={() => {
                          const label = editValue.trim();
                          getRpcClient().query("terminal.setLabel", { terminalId: term.id, label });
                          setUserLabels((prev) => label
                            ? { ...prev, [term.id]: label }
                            : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== term.id)));
                          setEditingId(null);
                        }}
                      />
                    );
                  }
                  return (
                    <span className={`flex items-center gap-1 min-w-0 ${isFocused ? 'text-base-100' : ''}`}>
                      <span className={`text-xs truncate ${isFocused ? 'text-base-100' : 'text-base-content/60'}`}>{displayTitle}</span>
                      {isRenameable && (
                        <button
                          className="btn btn-ghost btn-xs opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0 h-auto min-h-0"
                          onClick={() => { setEditValue(userLabel || ""); setEditingId(term.id); }}
                          title="Rename"
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                    </span>
                  );
                })()}
                <div className={`flex items-center ${isFocused ? 'text-base-100' : ''}`}>
                  {term.isClaudeUi && (
                    <div className="dropdown dropdown-end">
                      <button tabIndex={0} className="btn btn-ghost btn-xs opacity-60 hover:opacity-100">&#8943;</button>
                      <ul tabIndex={0} className="dropdown-content menu p-1 shadow bg-base-200 rounded-box w-36 z-50 text-xs">
                        <li>
                          <button onClick={() => { claudeUiRefs.current.get(term.id)?.reset(); }}>
                            Reset session
                          </button>
                        </li>
                      </ul>
                    </div>
                  )}
                  {!fixedTerminalHeight && (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => toggleMaximize(term.id)}
                      title={isMaximized ? "Restore" : "Maximize"}
                    >
                      {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={() => closeTerminal(term.id)}
                    title={term.isSavedLog ? "Dismiss saved log" : term.isTaskLog ? "Close and kill task" : "Close terminal"}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className={`flex-1 overflow-hidden min-h-0 ${isCollapsed ? 'hidden' : ''}`}>
                {term.isClaudeUi && term.sessionId ? (
                  <ClaudeUiTab
                    ref={(r) => { if (r) claudeUiRefs.current.set(term.id, r); else claudeUiRefs.current.delete(term.id); }}
                    sessionId={term.sessionId}
                    onTitleChange={(title) => setTerminalTitles((prev) => ({ ...prev, [term.id]: title }))}
                  />
                ) : term.isClaudeSession ? (
                  <ClaudeSessionTab
                    worktreePath={worktreePath}
                    sessionId={term.sessionId}
                  />
                ) : term.isSessionHistory && term.sessionId ? (
                  <SessionHistoryTab
                    sessionId={term.sessionId}
                    worktreePath={worktreePath}
                  />
                ) : term.isTaskLog && term.taskId ? (
                  <TaskLogTab
                    taskId={term.taskId}
                    isVisible={true}
                  />
                ) : (
                  <TerminalTab
                    terminalId={term.id}
                    worktreePath={worktreePath}
                    isVisible={true}
                    env={term.env}
                    initialCommand={term.initialCommand}
                    taskId={term.taskId}
                    onTitleChange={(title) => setTerminalTitles((prev) => ({ ...prev, [term.id]: title }))}
                  />
                )}
              </div>
            </div>
          </React.Fragment>
          );
        })}
      </div>
    </div>
  );
});

export default TerminalStack;
