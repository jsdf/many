import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { client } from "../main";
import TerminalTab from "./TerminalTab";
import TaskLogTab from "./TaskLogTab";
import SessionHistoryTab from "./SessionHistoryTab";

interface TerminalStackProps {
  worktreePath: string;
  repoPath?: string;
}

export interface TerminalStackHandle {
  createTerminalWithCommand: (env: Record<string, string>, initialCommand: string, taskId?: string) => void;
  openSessionHistory: (sessionId: string) => void;
  openTaskLog: (taskId: string, isSavedLog?: boolean) => void;
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
}

let terminalCounter = 0;

const TerminalStack = forwardRef<TerminalStackHandle, TerminalStackProps>(({ worktreePath, repoPath }, ref) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [sizes, setSizes] = useState<number[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const loadExisting = async () => {
      try {
        const existingIds = await client.getTerminalSessions.query({
          worktreePath,
        });
        if (cancelled) return;

        if (existingIds.length > 0) {
          const terminalInfos = existingIds.map((id) => ({ id }));
          setTerminals(terminalInfos);
          setSizes(existingIds.map(() => 1 / existingIds.length));
        }
      } catch (err) {
        console.error("Failed to load terminal sessions:", err);
      }
    };

    loadExisting();
    return () => {
      cancelled = true;
    };
  }, [worktreePath]);

  // Check for running tasks without an owning terminal (e.g. CLI-launched tasks)
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;

    const checkForOrphanTasks = async () => {
      try {
        const tasks = await client.listTasks.query({ repoPath });
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
      return next;
    });
  }, []);

  useImperativeHandle(ref, () => ({
    createTerminalWithCommand: (env: Record<string, string>, initialCommand: string, taskId?: string) => {
      addTerminal(env, initialCommand, taskId);
    },
    openSessionHistory,
    openTaskLog,
  }), [addTerminal, openSessionHistory, openTaskLog]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      // Check if this is a task log tab — kill the task when closing (unless it's a saved log)
      const term = terminals.find((t) => t.id === terminalId);
      if (term?.isTaskLog && term.taskId && !term.isSavedLog) {
        try {
          await client.killTaskById.mutate({ taskId: term.taskId });
        } catch {
          // Task may already be dead
        }
      } else if (!term?.isTaskLog) {
        try {
          await client.closeTerminal.mutate({ terminalId });
        } catch {
          // Session may already be dead
        }
      }
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
      setDragging(dividerIndex);
    },
    []
  );

  useEffect(() => {
    if (dragging === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const totalHeight = rect.height;
      const relY = e.clientY - rect.top;
      const fraction = relY / totalHeight;

      setSizes((prev) => {
        const next = [...prev];
        let sumBefore = 0;
        for (let i = 0; i <= dragging; i++) sumBefore += next[i];
        const pairSize = next[dragging] + next[dragging + 1];
        const pairStart = sumBefore - next[dragging];

        const minSize = 0.05;
        let newTop = fraction - pairStart;
        newTop = Math.max(minSize, Math.min(pairSize - minSize, newTop));

        next[dragging] = newTop;
        next[dragging + 1] = pairSize - newTop;
        return next;
      });
    };

    const handleMouseUp = () => {
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
    <div className="flex flex-col h-full overflow-hidden" ref={containerRef}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-base-200 border-b border-base-300 shrink-0">
        <span className="text-sm text-base-content/60 font-medium">Terminals</span>
        <button className="btn btn-soft btn-neutral btn-xs" onClick={createTerminal}>
          + New
        </button>
      </div>
      <div
        className="flex-1 flex flex-col overflow-hidden min-h-0"
        style={{ userSelect: dragging !== null ? "none" : undefined }}
      >
        {!hasTerminals && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-base-content/60">
            <p>No terminals open</p>
            <button className="btn btn-soft btn-neutral" onClick={createTerminal}>
              + New Terminal
            </button>
          </div>
        )}
        {terminals.map((term, i) => (
          <React.Fragment key={term.id}>
            {i > 0 && (
              <div
                className={`h-1 shrink-0 cursor-ns-resize transition-colors ${dragging === i - 1 ? 'bg-primary' : 'bg-base-300 hover:bg-primary'}`}
                onMouseDown={(e) => handleMouseDown(i - 1, e)}
              />
            )}
            <div
              className="flex flex-col overflow-hidden min-h-[60px]"
              style={{
                flex: `${sizes[i] ?? 1 / terminals.length} 0 0`,
                minHeight: 0,
              }}
            >
              <div className="flex items-center justify-between px-2.5 py-[3px] bg-base-300 border-b border-base-300 shrink-0">
                <span className="text-xs text-base-content/60">
                  {term.isSessionHistory ? "Session History" : term.isSavedLog ? "Saved Log (read-only)" : term.isTaskLog ? "Task Log (read-only)" : `Terminal ${i + 1}`}
                </span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => closeTerminal(term.id)}
                  title={term.isSavedLog ? "Dismiss saved log" : term.isTaskLog ? "Close and kill task" : "Close terminal"}
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-hidden min-h-0">
                {term.isSessionHistory && term.sessionId ? (
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
                  />
                )}
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
});

export default TerminalStack;
