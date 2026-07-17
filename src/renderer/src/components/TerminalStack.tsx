import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { Maximize2, Minimize2, ChevronDown, ChevronUp, Pencil, X, Clock, Type, MessageSquareText, SquareTerminal, Play } from "lucide-react";
import { getRpcClient } from "../rpc-client";
import TerminalTab from "./TerminalTab";
import TaskLogTab from "./TaskLogTab";
import SessionHistoryTab from "./SessionHistoryTab";
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
  resumeClaudeCodeSession: (sessionId: string, command: string) => void;
  openClaudeUiSession: () => void;
  resumeClaudeUiSession: (sessionId: string) => void;
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
  isClaudeUi?: boolean;
  justCreated?: boolean; // freshly created this session (not restored) — focus its input on mount
  resumeSessionId?: string; // claude-code session this terminal was opened to resume
  savedTaskId?: string; // restored saved-terminal snapshot: task record id to dismiss/resume from
  // Claude Code session id running in this terminal, known deterministically
  // because we launched it with `--session-id`/`--resume`. Enables the
  // terminal<->transcript toggle and dedupe against discovered sessions.
  claudeSessionId?: string;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleTimeString();
}

function formatAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Clock icon in the terminal header that reveals the session's start time and
// most-recent-output time on hover. Fetches fresh timestamps from the server on
// each hover so "last activity" reflects live output.
const TerminalActivityInfo: React.FC<{ worktreePath: string; terminalId: string }> = ({
  worktreePath,
  terminalId,
}) => {
  const [info, setInfo] = useState<{ createdAt?: number; lastDataAt?: number } | null>(null);
  const [open, setOpen] = useState(false);

  const handleEnter = useCallback(async () => {
    setOpen(true);
    try {
      const sessions = await getRpcClient().query("terminal.listSessions", { worktreePath });
      const s = sessions.find((x) => x.id === terminalId);
      if (s) setInfo({ createdAt: s.createdAt, lastDataAt: s.lastDataAt });
    } catch {
      // Session may be gone; leave prior info in place
    }
  }, [worktreePath, terminalId]);

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setOpen(false)}
    >
      <button className="btn btn-ghost btn-xs" tabIndex={-1} title="Terminal timing">
        <Clock size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 whitespace-nowrap rounded bg-base-300 text-base-content px-2 py-1 text-xs shadow-lg">
          {info?.createdAt != null ? (
            <div>Started: {formatTime(info.createdAt)}</div>
          ) : (
            <div>Started: unknown</div>
          )}
          {info?.lastDataAt != null ? (
            <div>Last activity: {formatTime(info.lastDataAt)} ({formatAgo(info.lastDataAt)})</div>
          ) : (
            <div>Last activity: none</div>
          )}
        </div>
      )}
    </div>
  );
};

let terminalCounter = 0;

const TerminalStack = forwardRef<TerminalStackHandle, TerminalStackProps>(({ worktreePath, repoPath, claudeCommand, fixedTerminalHeight }, ref) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [sizes, setSizes] = useState<number[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [terminalTitles, setTerminalTitles] = useState<Record<string, string>>({});
  // Terminal/Claude tabs that rang a bell (or finished a Claude turn) and haven't
  // been interacted with since. Drives the attention dot in each pane's title.
  const [bellIds, setBellIds] = useState<Set<string>>(new Set());
  const markBell = useCallback((terminalId: string) => {
    setBellIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)));
  }, []);
  const clearBell = useCallback((terminalId: string) => {
    setBellIds((prev) => {
      if (!prev.has(terminalId)) return prev;
      const next = new Set(prev);
      next.delete(terminalId);
      return next;
    });
  }, []);
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [maximizedId, setMaximizedId] = useState<string | null>(
    () => localStorage.getItem(`terminalMaximized:${worktreePath}`) || null,
  );
  const [minimizedIds, setMinimizedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`terminalMinimized:${worktreePath}`);
      return raw ? new Set<string>(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [serif, setSerif] = useState<boolean>(
    () => localStorage.getItem("terminalSerif") === "1",
  );
  // Terminals currently showing the formatted transcript view instead of the
  // live xterm. Only applies to terminals with a known claudeSessionId.
  const [historyViewIds, setHistoryViewIds] = useState<Set<string>>(new Set());
  const focusedId = useFocusedTerminal();

  // Persist maximize/minimize state so it survives MainContent unmounting when
  // switching to the Projects tab and back. Terminal ids are stable (restored
  // from server sessions), so the stored ids still match after a remount.
  useEffect(() => {
    if (maximizedId) localStorage.setItem(`terminalMaximized:${worktreePath}`, maximizedId);
    else localStorage.removeItem(`terminalMaximized:${worktreePath}`);
  }, [maximizedId, worktreePath]);
  useEffect(() => {
    if (minimizedIds.size > 0)
      localStorage.setItem(`terminalMinimized:${worktreePath}`, JSON.stringify([...minimizedIds]));
    else localStorage.removeItem(`terminalMinimized:${worktreePath}`);
  }, [minimizedIds, worktreePath]);

  const toggleSerif = useCallback(() => {
    setSerif((prev) => {
      const next = !prev;
      localStorage.setItem("terminalSerif", next ? "1" : "0");
      return next;
    });
  }, []);

  const toggleHistoryView = useCallback((terminalId: string) => {
    setHistoryViewIds((prev) => {
      const next = new Set(prev);
      if (next.has(terminalId)) next.delete(terminalId);
      else next.add(terminalId);
      return next;
    });
  }, []);

  const toggleMaximize = useCallback((terminalId: string) => {
    setMaximizedId((prev) => (prev === terminalId ? null : terminalId));
  }, []);
  const toggleMinimize = useCallback((terminalId: string) => {
    setMinimizedIds((prev) => {
      const next = new Set(prev);
      if (next.has(terminalId)) next.delete(terminalId);
      else next.add(terminalId);
      return next;
    });
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
        // Merge, don't replace: the saved-terminal restore effect runs
        // concurrently and may have already appended read-only tabs. Replacing
        // here would race-wipe them.
        setTerminals((prev) => {
          const existingIds = new Set(prev.map((t) => t.id));
          const merged = [...prev, ...tabs.filter((t) => !existingIds.has(t.id))];
          setSizes(merged.map(() => 1 / merged.length));
          return merged;
        });
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
        // Show running tasks (CLI-launched) — CLI task saved logs are opened on
        // demand via "View Log" button.
        const runningTasksForWorktree = tasks.filter(
          (t: any) => t.worktreePath === worktreePath && t.logFile && t.status === "running"
        );
        // Restore terminals that were killed on shutdown/exit: read-only view +
        // resume. Claude ones (with a session id) show the transcript; others
        // show the saved scrollback log.
        const savedTerminals = tasks.filter(
          (t: any) =>
            t.worktreePath === worktreePath &&
            t.status !== "running" &&
            t.prompt === "Terminal session (saved on shutdown)"
        );

        if (cancelled || (runningTasksForWorktree.length === 0 && savedTerminals.length === 0)) return;

        setTerminals((prev) => {
          // Don't add if we already have a tab for this task
          const existingTaskIds = new Set(prev.filter((t) => t.taskId || t.savedTaskId).map((t) => t.taskId || t.savedTaskId));
          const newRunningTabs = runningTasksForWorktree
            .filter((t: any) => !existingTaskIds.has(t.id))
            .map((t: any) => ({
              id: `task-log-${t.id}`,
              taskId: t.id,
              isTaskLog: true,
              isSavedLog: t.status !== "running",
            }));
          const newSavedTabs = savedTerminals
            .filter((t: any) => !existingTaskIds.has(t.id))
            .map((t: any) =>
              t.claudeSessionId
                ? {
                    id: `saved-session-${t.id}`,
                    savedTaskId: t.id,
                    isSessionHistory: true,
                    sessionId: t.claudeSessionId,
                    claudeSessionId: t.claudeSessionId,
                  }
                : {
                    id: `saved-log-${t.id}`,
                    savedTaskId: t.id,
                    taskId: t.id,
                    isTaskLog: true,
                    isSavedLog: true,
                  }
            );

          const newTabs = [...newRunningTabs, ...newSavedTabs];
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

  const addTerminal = useCallback((env?: Record<string, string>, initialCommand?: string, taskId?: string, claudeSessionId?: string) => {
    terminalCounter++;
    const id = `${worktreePath}-term-${Date.now()}-${terminalCounter}`;
    setTerminals((prev) => {
      const next = [...prev, { id, env, initialCommand, taskId, claudeSessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, [worktreePath]);

  const createTerminal = useCallback(() => {
    addTerminal();
  }, [addTerminal]);

  // Launch a fresh Claude Code session in a terminal with a pre-assigned session
  // id, so we can associate the terminal with the on-disk transcript (dedupe +
  // terminal<->history toggle) without guessing.
  const launchClaude = useCallback(() => {
    const sessionId = crypto.randomUUID();
    const base = claudeCommand || "claude";
    addTerminal(undefined, `${base} --session-id ${sessionId}`, undefined, sessionId);
  }, [addTerminal, claudeCommand]);

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

  const resumeClaudeCodeSession = useCallback((sessionId: string, command: string) => {
    setTerminals((prev) => {
      // Don't open a duplicate pane when this session is already being resumed.
      if (prev.some((t) => t.resumeSessionId === sessionId)) return prev;
      terminalCounter++;
      const id = `claude-resume-${sessionId}`;
      const next = [...prev, { id, initialCommand: command, resumeSessionId: sessionId, claudeSessionId: sessionId }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, []);

  // Resume a restored saved-terminal snapshot: Claude ones reopen with
  // `claude --resume <id>`; plain shells just get a fresh terminal in the
  // worktree. Either way the read-only snapshot is dismissed.
  const resumeSavedTerminal = useCallback((term: TerminalInfo) => {
    if (term.claudeSessionId) {
      const base = claudeCommand || "claude";
      resumeClaudeCodeSession(term.claudeSessionId, `${base} --resume ${term.claudeSessionId}`);
    } else {
      addTerminal();
    }
    if (term.savedTaskId) {
      getRpcClient().query("task.remove", { taskId: term.savedTaskId }).catch(() => {});
    }
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== term.id);
      setSizes(next.length ? next.map(() => 1 / next.length) : []);
      return next;
    });
  }, [claudeCommand, resumeClaudeCodeSession, addTerminal]);

  const openClaudeUiSession = useCallback(async () => {
    // The session is server-owned (it outlives the tab), so create it first and
    // key the tab on its id. Restoring on return uses the same id, so a returning
    // tab re-attaches to the live session instead of spawning a duplicate.
    const { sessionId } = await getRpcClient().query("claudeui.create", { worktreePath });
    setTerminals((prev) => {
      const id = `claude-ui-${sessionId}`;
      const next = [...prev, { id, isClaudeUi: true, sessionId, justCreated: true }];
      setSizes(next.map(() => 1 / next.length));
      setMaximizedId((m) => (m !== null ? id : m));
      return next;
    });
  }, [worktreePath]);

  const resumeClaudeUiSession = useCallback(async (sessionId: string) => {
    const id = `claude-ui-${sessionId}`;
    // If a tab for this session is already open, just focus it.
    let exists = false;
    setTerminals((prev) => {
      exists = prev.some((t) => t.id === id);
      return prev;
    });
    if (exists) return;
    // Resume the on-disk conversation server-side (keyed by its session id), then
    // open a Claude UI tab that re-attaches and replays the prior transcript.
    await getRpcClient().query("claudeui.resume", { worktreePath, sessionId });
    setTerminals((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
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
    resumeClaudeCodeSession,
    openClaudeUiSession,
    resumeClaudeUiSession,
    openTaskLog,
  }), [addTerminal, openSessionHistory, openTaskLog, resumeClaudeCodeSession, openClaudeUiSession, resumeClaudeUiSession]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const term = terminals.find((t) => t.id === terminalId);
      if (term?.savedTaskId) {
        // Dismissing a restored snapshot: delete its saved record + log so it
        // doesn't reappear on next open.
        getRpcClient().query("task.remove", { taskId: term.savedTaskId }).catch(() => {});
      }
      if (term?.isClaudeUi && term.sessionId) {
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
      clearBell(terminalId);
      setMaximizedId((prev) => (prev === terminalId ? null : prev));
      setMinimizedIds((prev) => {
        if (!prev.has(terminalId)) return prev;
        const next = new Set(prev);
        next.delete(terminalId);
        return next;
      });
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

  // flex-grow only distributes ALL free space when the grow factors sum to >= 1.
  // Minimized terminals contribute grow 0, so the remaining visible terminals'
  // sizes (which sum to <1) would leave a gap. Normalize by the visible sum so
  // they fill the space while keeping their relative ratios.
  const visibleSizeSum = terminals.reduce(
    (sum, term, i) => (minimizedIds.has(term.id) ? sum : sum + (sizes[i] ?? 1 / terminals.length)),
    0
  );

  return (
    <div className={`flex flex-col ${fixedTerminalHeight ? '' : 'h-full overflow-hidden'}`}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-base-100 border-b border-base-300 shrink-0">
        <span className="text-sm text-base-content/60 font-medium">Terminals</span>
        <div className="flex gap-1">
          <button
            className={`btn btn-xs ${serif ? 'btn-neutral' : 'btn-outline btn-neutral'}`}
            onClick={toggleSerif}
            title={serif ? "Switch all terminals to monospace font" : "Switch all terminals to serif font"}
          >
            <Type size={14} />
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={openClaudeUiSession}>
            + Claude (UI)
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={launchClaude}>
            + Claude (term)
          </button>
          <button className="btn btn-outline btn-neutral btn-xs" onClick={createTerminal}>
            + Terminal
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
              <button className="btn btn-outline btn-neutral" onClick={launchClaude}>
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
          const isCollapsedByMax = maximizedId !== null && !isMaximized;
          const isMinimized = !isMaximized && minimizedIds.has(term.id);
          const showHeaderOnly = isCollapsedByMax || isMinimized;
          const isFocused = focusedId === term.id;
          return (
          <React.Fragment key={term.id}>
            {i > 0 && !fixedTerminalHeight && !maximizedId && (
              minimizedIds.has(term.id) || minimizedIds.has(terminals[i - 1].id) ? (
                <div className="h-1 shrink-0" />
              ) : (
                <div
                  className={`h-1 shrink-0 cursor-ns-resize transition-colors ${dragging === i - 1 ? 'bg-primary' : 'bg-base-300 hover:bg-primary'}`}
                  onMouseDown={(e) => handleMouseDown(i - 1, e)}
                />
              )
            )}
            <div
              className={`flex flex-col overflow-hidden ${fixedTerminalHeight ? '' : showHeaderOnly ? '' : 'min-h-[60px]'}`}
              style={fixedTerminalHeight
                ? { height: fixedTerminalHeight }
                : isMaximized
                  ? { flex: '1 0 0', minHeight: 0 }
                  : showHeaderOnly
                    ? { flex: '0 0 auto' }
                    : { flex: `${(sizes[i] ?? 1 / terminals.length) / (visibleSizeSum || 1)} 0 0`, minHeight: 0 }
              }
              onMouseDown={() => setFocusedTerminal(term.id)}
              onFocus={() => setFocusedTerminal(term.id)}
            >
              <div className={`group flex items-center justify-between px-2.5 py-[3px] border-b shrink-0 ${isFocused ? 'bg-base-content border-base-content' : 'bg-base-100 border-base-300'}`}>
                {(() => {
                  const isRenameable = !term.isTaskLog && !term.isSavedLog && !term.isSessionHistory;
                  const dynamicTitle = terminalTitles[term.id];
                  const userLabel = userLabels[term.id];
                  let displayTitle: string;
                  if (term.isSessionHistory) displayTitle = term.savedTaskId ? "Saved Claude (read-only)" : "Session History";
                  else if (term.isSavedLog) displayTitle = "Saved Log (read-only)";
                  else if (term.isTaskLog) displayTitle = "Task Log (read-only)";
                  else if (userLabel) displayTitle = dynamicTitle ? `${userLabel} | ${dynamicTitle}` : userLabel;
                  else if (term.isClaudeUi) displayTitle = dynamicTitle ? `Claude UI: ${dynamicTitle}` : "Claude UI";
                  else displayTitle = dynamicTitle ? `Terminal ${i + 1}: ${dynamicTitle}` : `Terminal ${i + 1}`;

                  if (editingId !== null && editingId === term.id) {
                    return (
                      <input
                        autoFocus
                        className={`text-xs bg-transparent border border-primary rounded px-1 outline-none min-w-0 flex-1 mr-2 ${isFocused ? 'text-base-100' : 'text-base-content'}`}
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
                      {bellIds.has(term.id) && (
                        <span
                          className="shrink-0 w-2 h-2 rounded-full bg-warning"
                          title="Activity since last interaction"
                        />
                      )}
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
                  {!term.isTaskLog && !term.isSavedLog && !term.isSessionHistory && !term.isClaudeUi && (
                    <TerminalActivityInfo worktreePath={worktreePath} terminalId={term.id} />
                  )}
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
                  {term.savedTaskId && (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => resumeSavedTerminal(term)}
                      title={term.claudeSessionId ? "Resume this Claude session" : "Start a new terminal here"}
                    >
                      <Play size={14} />
                    </button>
                  )}
                  {term.claudeSessionId && !term.isSessionHistory && !term.isClaudeUi && (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => toggleHistoryView(term.id)}
                      title={historyViewIds.has(term.id) ? "Show live terminal" : "Show formatted transcript"}
                    >
                      {historyViewIds.has(term.id) ? <SquareTerminal size={14} /> : <MessageSquareText size={14} />}
                    </button>
                  )}
                  {!fixedTerminalHeight && !isMaximized && (
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={() => toggleMinimize(term.id)}
                      title={isMinimized ? "Expand" : "Minimize"}
                    >
                      {isMinimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
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
                    title={term.savedTaskId ? "Dismiss saved terminal" : term.isSavedLog ? "Dismiss saved log" : term.isTaskLog ? "Close and kill task" : "Close terminal"}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className={`flex-1 overflow-hidden min-h-0 ${showHeaderOnly ? 'hidden' : ''}`}>
                {term.isClaudeUi && term.sessionId ? (
                  <ClaudeUiTab
                    ref={(r) => { if (r) claudeUiRefs.current.set(term.id, r); else claudeUiRefs.current.delete(term.id); }}
                    sessionId={term.sessionId}
                    autoFocus={term.justCreated}
                    onTitleChange={(title) => setTerminalTitles((prev) => ({ ...prev, [term.id]: title }))}
                    onAttention={() => markBell(term.id)}
                    onClearAttention={() => clearBell(term.id)}
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
                ) : historyViewIds.has(term.id) && term.claudeSessionId ? (
                  <SessionHistoryTab
                    sessionId={term.claudeSessionId}
                    worktreePath={worktreePath}
                  />
                ) : (
                  <TerminalTab
                    terminalId={term.id}
                    worktreePath={worktreePath}
                    isVisible={true}
                    serif={serif}
                    claudeSessionId={term.claudeSessionId}
                    env={term.env}
                    initialCommand={term.initialCommand}
                    taskId={term.taskId}
                    onTitleChange={(title) => setTerminalTitles((prev) => ({ ...prev, [term.id]: title }))}
                    onBell={() => markBell(term.id)}
                    onInput={() => clearBell(term.id)}
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
