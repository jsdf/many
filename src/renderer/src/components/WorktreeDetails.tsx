import React, { useState, useEffect, useCallback, useRef } from "react";
import { Worktree, GitStatus } from "../types";
import { getRpcClient } from "../rpc-client";
import BranchChanges from "./BranchChanges";

interface TaskRecord {
  id: string;
  pid: number;
  worktreePath: string;
  prompt: string;
  taskCommand: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "unknown";
  exitCode?: number;
  logFile?: string;
  launchedBy: "cli" | "web";
  branch: string;
}

interface ClaudeSession {
  sessionId: string;
  firstPrompt: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  isRunning: boolean;
  projectPath: string;
}

interface WorktreeDetailsProps {
  worktree: Worktree;
  repoPath: string;
  onRetryTask?: (env: Record<string, string>, command: string) => void;
  onResumeSession?: (sessionId: string) => void;
  onViewSessionHistory?: (sessionId: string) => void;
  onViewTaskLog?: (taskId: string, isSavedLog: boolean) => void;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  repoPath,
  onRetryTask,
  onResumeSession,
  onViewSessionHistory,
  onViewTaskLog,
}) => {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusCollapsed, setStatusCollapsed] = useState(true);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(true);
  const [notes, setNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadGitStatus = async () => {
    if (!worktree.path) return;
    setStatusLoading(true);
    try {
      const status = await getRpcClient().query("worktree.status", {
        worktreePath: worktree.path,
      });
      setGitStatus(status);
    } catch (err) {
      console.error("Failed to load git status:", err);
    } finally {
      setStatusLoading(false);
    }
  };

  const loadTask = useCallback(async () => {
    if (!worktree.path) return;
    try {
      const tasks = await getRpcClient().query("task.list", { repoPath });
      const match = tasks.find((t: TaskRecord) => t.worktreePath === worktree.path);
      setTask(match || null);
    } catch {
      setTask(null);
    }
  }, [worktree.path, repoPath]);

  const loadClaudeSessions = useCallback(async () => {
    if (!worktree.path) return;
    try {
      const sessions = await getRpcClient().query("claude.sessions", { worktreePath: worktree.path }) as any[];
      setClaudeSessions(sessions);
    } catch {
      setClaudeSessions([]);
    }
  }, [worktree.path]);

  const loadNotes = useCallback(async () => {
    if (!worktree.branch) { setNotes(""); setNotesLoaded(true); return; }
    try {
      const text = await getRpcClient().query("worktree.getNotes", {
        repoPath,
        branch: worktree.branch,
      });
      setNotes(text);
    } catch {
      setNotes("");
    }
    setNotesLoaded(true);
  }, [worktree.branch, repoPath]);

  const saveNotes = useCallback((text: string) => {
    if (!worktree.branch) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      getRpcClient().query("worktree.setNotes", {
        repoPath,
        branch: worktree.branch!,
        notes: text,
      }).catch(() => {});
    }, 500);
  }, [worktree.branch, repoPath]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setNotes(text);
    saveNotes(text);
  };

  useEffect(() => {
    loadGitStatus();
    loadTask();
    loadClaudeSessions();
    setNotesLoaded(false);
    loadNotes();
  }, [worktree.path]);

  // Poll for task status updates when task is running
  useEffect(() => {
    if (task?.status === "running") {
      const interval = setInterval(loadTask, 5000);
      return () => clearInterval(interval);
    }
  }, [task?.status, loadTask]);

  // Poll for Claude session updates
  useEffect(() => {
    const interval = setInterval(loadClaudeSessions, 10_000);
    return () => clearInterval(interval);
  }, [loadClaudeSessions]);

  const handleKillTask = async () => {
    if (!task) return;
    try {
      await getRpcClient().query("task.kill", { taskId: task.id });
      await loadTask();
    } catch (err) {
      console.error("Failed to kill task:", err);
    }
  };

  const statusColor = (s: string) => {
    switch (s) {
      case "running": return "text-success";
      case "completed": return "text-base-content/60";
      case "failed": return "text-error";
      case "unknown": return "text-warning";
      default: return "";
    }
  };

  const formatAge = (date: string) => {
    const ms = Date.now() - new Date(date).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="p-5 overflow-auto h-full w-full min-w-0">
      {worktree.branch && notesLoaded && (
        <div className="mb-3">
          <h3 className="text-base font-semibold mb-3">Notes</h3>
          <textarea
            className="textarea textarea-bordered w-full bg-base-200 text-sm font-mono leading-relaxed"
            rows={3}
            placeholder="What are you working on?"
            value={notes}
            onChange={handleNotesChange}
          />
        </div>
      )}
      {task && (
        <div className="mb-3">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-base font-semibold">Task</h3>
            <div className="flex gap-2">
              {task.status === "running" && (
                <button
                  className="btn btn-soft btn-error btn-sm"
                  onClick={handleKillTask}
                >
                  Kill
                </button>
              )}
              {task.logFile && onViewTaskLog && (
                <button
                  className="btn btn-soft btn-neutral btn-sm"
                  onClick={() => onViewTaskLog(task.id, task.status !== "running")}
                >
                  View Log
                </button>
              )}
              {task.status !== "running" && onRetryTask && task.taskCommand && (
                <button
                  className="btn btn-soft btn-primary btn-sm"
                  onClick={() => onRetryTask(
                    { MANY_TASK_PROMPT: task.prompt },
                    task.taskCommand,
                  )}
                >
                  Retry
                </button>
              )}
            </div>
          </div>
          <div className="bg-base-200 border border-base-300 rounded-lg p-4">
            <div className="flex items-center gap-3 mb-2">
              <span className={`font-semibold text-sm ${statusColor(task.status)}`}>
                {task.status}
              </span>
              <span className="text-xs text-base-content/50">
                {formatAge(task.startedAt)} · {task.launchedBy}
              </span>
              {task.exitCode !== undefined && task.exitCode !== null && (
                <span className="text-xs text-base-content/50">
                  exit {task.exitCode}
                </span>
              )}
            </div>
            <p className="text-sm text-base-content/80 m-0 whitespace-pre-wrap">{task.prompt}</p>
            <p className="text-xs text-base-content/40 mt-2 m-0 font-mono">{task.id}</p>
          </div>

        </div>
      )}

      {claudeSessions.length > 0 && (
        <div className="mb-3">
          <div className="flex justify-between items-center mb-3">
            <h3
              className="text-base font-semibold cursor-pointer select-none"
              onClick={() => setSessionsCollapsed(!sessionsCollapsed)}
            >
              <span className="text-base-content/40 mr-1">{sessionsCollapsed ? "▶" : "▼"}</span>
              Claude Sessions
              {sessionsCollapsed && (
                <span className="text-xs font-normal text-base-content/50 ml-2">
                  {claudeSessions.length} session{claudeSessions.length !== 1 ? "s" : ""}
                  {claudeSessions.some(s => s.isRunning) && (
                    <span className="text-success ml-1">
                      ({claudeSessions.filter(s => s.isRunning).length} running)
                    </span>
                  )}
                </span>
              )}
            </h3>
          </div>
          {!sessionsCollapsed && (
            <div className="flex flex-col gap-2">
              {claudeSessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="bg-base-200 border border-base-300 rounded-lg p-3"
                >
                  <div className="flex items-center gap-2 mb-1 min-w-0">
                    {session.isRunning && (
                      <span className="badge badge-success badge-xs shrink-0">running</span>
                    )}
                    {session.gitBranch && (
                      <span className="text-xs text-base-content/50 font-mono truncate min-w-0">{session.gitBranch}</span>
                    )}
                    <span className="text-xs text-base-content/40 shrink-0">{formatAge(session.modified)}</span>
                    <span className="text-xs text-base-content/40 shrink-0">{session.messageCount} msgs</span>
                  </div>
                  <p className="text-sm text-base-content/80 m-0 line-clamp-2">
                    {(session.summary || session.firstPrompt || "").replace(/<[^>]+>/g, "").trim() || <span className="italic text-base-content/40">No prompt</span>}
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    {onViewSessionHistory && (
                      <button
                        className="btn btn-soft btn-neutral btn-xs"
                        onClick={() => onViewSessionHistory(session.sessionId)}
                      >
                        History
                      </button>
                    )}
                    {onResumeSession && (
                      <button
                        className="btn btn-soft btn-primary btn-xs"
                        onClick={() => onResumeSession(session.sessionId)}
                      >
                        Resume
                      </button>
                    )}
                    <span className="text-[10px] text-base-content/30 font-mono">{session.sessionId.slice(0, 8)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-3">
        <div className="flex justify-between items-center mb-3">
          <h3
            className="text-base font-semibold cursor-pointer select-none"
            onClick={() => setStatusCollapsed(!statusCollapsed)}
          >
            <span className="text-base-content/40 mr-1">{statusCollapsed ? "▶" : "▼"}</span>
            Git Status
            {statusCollapsed && gitStatus && gitStatus.hasChanges && (
              <span className="text-xs font-normal text-base-content/50 ml-2">
                {[
                  gitStatus.staged.length > 0 && `${gitStatus.staged.length} staged`,
                  gitStatus.modified.length > 0 && `${gitStatus.modified.length} modified`,
                  gitStatus.not_added.length > 0 && `${gitStatus.not_added.length} untracked`,
                  gitStatus.deleted.length > 0 && `${gitStatus.deleted.length} deleted`,
                  gitStatus.created.length > 0 && `${gitStatus.created.length} created`,
                ].filter(Boolean).join(", ")}
              </span>
            )}
            {statusCollapsed && gitStatus && !gitStatus.hasChanges && (
              <span className="text-xs font-normal text-success ml-2">clean</span>
            )}
          </h3>
          {!statusCollapsed && (
            <button
              className="btn btn-soft btn-neutral btn-sm"
              onClick={loadGitStatus}
              disabled={statusLoading}
            >
              {statusLoading ? "Refreshing..." : "Refresh"}
            </button>
          )}
        </div>
        {!statusCollapsed && <div className="bg-neutral border border-base-content/10 rounded-lg p-4 text-neutral-content">
          {statusLoading && !gitStatus ? (
            <p className="text-base-content/60 italic m-0">Loading...</p>
          ) : gitStatus && gitStatus.hasChanges ? (
            <div className="flex flex-col gap-3">
              <pre className="text-sm m-0"><code>{[
                ...gitStatus.staged.map((file) => (
                  <span key={`staged-${file}`} className="text-success">A  {file}{"\n"}</span>
                )),
                ...gitStatus.modified.map((file) => (
                  <span key={`modified-${file}`} className="text-warning">M  {file}{"\n"}</span>
                )),
                ...gitStatus.not_added.map((file) => (
                  <span key={`untracked-${file}`} className="text-base-content/60">?  {file}{"\n"}</span>
                )),
                ...gitStatus.deleted.map((file) => (
                  <span key={`deleted-${file}`} className="text-error">D  {file}{"\n"}</span>
                )),
                ...gitStatus.created.map((file) => (
                  <span key={`created-${file}`} className="text-success">A  {file}{"\n"}</span>
                )),
              ]}</code></pre>
            </div>
          ) : gitStatus ? (
            <p className="text-success m-0">Working tree clean</p>
          ) : (
            <p className="text-base-content/60 italic m-0">Failed to load status</p>
          )}
        </div>}
      </div>

      {worktree.path && repoPath && (
        <BranchChanges worktreePath={worktree.path} repoPath={repoPath} commit={worktree.commit} />
      )}
    </div>
  );
};

export default WorktreeDetails;
