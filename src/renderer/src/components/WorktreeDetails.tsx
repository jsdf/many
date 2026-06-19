import React, { useState, useEffect, useCallback, useRef } from "react";
import { Worktree, GitStatus, ChangeHandlingOption } from "../types";
import type { BranchStackResult } from "../../../shared/protocol";
import { getRpcClient } from "../rpc-client";
import { setMuxNotes, getMuxBranchInfo, type MuxBranchInfo } from "../mux-client";
import BranchChanges from "./BranchChanges";
import { ChevronRight, ChevronDown, CircleDot, Circle } from "lucide-react";

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
  sessionType?: "chat" | "claude-code";
  closed?: boolean;
}

interface WorktreeDetailsProps {
  worktree: Worktree;
  repoPath: string;
  onRetryTask?: (env: Record<string, string>, command: string) => void;
  onResumeSession?: (sessionId: string, sessionType?: "chat" | "claude-code") => void;
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
  const [muxInfo, setMuxInfo] = useState<MuxBranchInfo | null>(null);
  const [branchStack, setBranchStack] = useState<BranchStackResult | null>(null);
  const [stackCollapsed, setStackCollapsed] = useState(true);
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchHandling, setSwitchHandling] = useState<ChangeHandlingOption>("commit");
  const [switchCommitMsg, setSwitchCommitMsg] = useState("wip changes");
  const [switchNoVerify, setSwitchNoVerify] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
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
    if (!worktree.branch) { setNotes(""); setNotesLoaded(true); setMuxInfo(null); return; }
    try {
      const info = await getMuxBranchInfo(repoPath, worktree.branch);
      setNotes(info?.notes ?? "");
      setMuxInfo(info);
    } catch {
      setNotes("");
      setMuxInfo(null);
    }
    setNotesLoaded(true);
  }, [worktree.branch, repoPath]);

  const saveNotes = useCallback((text: string) => {
    if (!worktree.branch) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      setMuxNotes(repoPath, worktree.branch!, text).catch(() => {});
    }, 500);
  }, [worktree.branch, repoPath]);

  const handleNotesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setNotes(text);
    saveNotes(text);
  };

  const loadBranchStack = useCallback(async () => {
    if (!worktree.path || !worktree.branch) { setBranchStack(null); return; }
    try {
      const result = await getRpcClient().query("branch.stack", {
        worktreePath: worktree.path,
        repoPath,
      });
      setBranchStack(result);
    } catch {
      setBranchStack(null);
    }
  }, [worktree.path, worktree.branch, repoPath]);

  useEffect(() => {
    loadGitStatus();
    loadTask();
    loadClaudeSessions();
    loadBranchStack();
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

  const handleBranchClick = async (branch: string) => {
    if (!worktree.path) return;
    setSwitchError(null);
    const status = gitStatus ?? await getRpcClient().query("worktree.status", { worktreePath: worktree.path });
    if (status.hasChanges || status.hasStaged) {
      setSwitchTarget(branch);
      return;
    }
    await doCheckout(branch);
  };

  const doCheckout = async (branch: string) => {
    if (!worktree.path) return;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      await getRpcClient().query("branch.checkout", { worktreePath: worktree.path, branch });
      setSwitchTarget(null);
      loadBranchStack();
      loadGitStatus();
    } catch (err: any) {
      setSwitchError(err.message || "Checkout failed");
    } finally {
      setSwitchBusy(false);
    }
  };

  const handleSwitchWithChanges = async () => {
    if (!worktree.path || !switchTarget) return;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      switch (switchHandling) {
        case "commit":
          if (!switchCommitMsg.trim()) { setSwitchError("Commit message is required"); setSwitchBusy(false); return; }
          await getRpcClient().query("worktree.commit", { worktreePath: worktree.path, message: switchCommitMsg.trim(), noVerify: switchNoVerify });
          break;
        case "amend":
          await getRpcClient().query("worktree.amend", { worktreePath: worktree.path, noVerify: switchNoVerify });
          break;
        case "stash":
          await getRpcClient().query("worktree.stash", { worktreePath: worktree.path });
          break;
        case "clean":
          await getRpcClient().query("worktree.clean", { worktreePath: worktree.path });
          break;
        case "cancel":
          setSwitchTarget(null);
          setSwitchBusy(false);
          return;
      }
      await doCheckout(switchTarget);
    } catch (err: any) {
      setSwitchError(err.message || "Failed to handle changes");
      setSwitchBusy(false);
    }
  };

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
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-base font-semibold">Notes</h3>
            {muxInfo?.linearUrl && (
              <button
                className="btn btn-xs btn-accent btn-soft"
                title={`Open Linear: ${muxInfo.linearId}`}
                onClick={() => window.open(muxInfo.linearUrl, '_blank', 'noopener,noreferrer')}
              >
                {muxInfo.linearId || 'Linear'}
              </button>
            )}
          </div>
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
              <span className="text-base-content/40 mr-1 inline-flex items-center align-middle">{sessionsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
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
                    {session.sessionType === "chat" ? (
                      <span className="badge badge-info badge-xs shrink-0">chat</span>
                    ) : session.sessionType === "claude-code" ? (
                      <span className="badge badge-neutral badge-xs shrink-0">cli</span>
                    ) : null}
                    {session.isRunning && !session.closed && (
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
                        onClick={() => onResumeSession(session.sessionId, session.sessionType)}
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

      {branchStack && branchStack.stack.length > 1 && (
        <div className="mb-3">
          <h3
            className="text-base font-semibold cursor-pointer select-none mb-3"
            onClick={() => setStackCollapsed(!stackCollapsed)}
          >
            <span className="text-base-content/40 mr-1 inline-flex items-center align-middle">{stackCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
            Branch Stack
            {stackCollapsed && (
              <span className="text-xs font-normal text-base-content/50 ml-2">
                {branchStack.stack.filter(e => !e.isTrunk).length} branch{branchStack.stack.filter(e => !e.isTrunk).length !== 1 ? "es" : ""}
                {branchStack.source === "graphite" && (
                  <span className="text-base-content/40 ml-1">(graphite)</span>
                )}
              </span>
            )}
          </h3>
          {!stackCollapsed && (
            <div className="bg-base-200 border border-base-300 rounded-lg p-3">
              <div className="flex flex-col gap-0.5 font-mono text-sm">
                {branchStack.stack.map((entry) => (
                  <div key={entry.branch} className="flex items-center gap-2">
                    <span className="text-base-content/30 w-4 shrink-0 inline-flex items-center justify-center">
                      {entry.isCurrent ? <CircleDot size={12} /> : <Circle size={12} />}
                    </span>
                    <span
                      className={
                        entry.isCurrent
                          ? "text-primary font-semibold truncate"
                          : "text-base-content/80 truncate cursor-pointer hover:text-primary hover:underline"
                      }
                      onClick={entry.isCurrent ? undefined : () => handleBranchClick(entry.branch)}
                    >
                      {entry.branch}
                    </span>
                    {entry.isCurrent && (
                      <span className="badge badge-primary badge-xs shrink-0">HEAD</span>
                    )}
                    {entry.isTrunk && !entry.isCurrent && (
                      <span className="badge badge-neutral badge-xs shrink-0">trunk</span>
                    )}
                  </div>
                ))}
              </div>
              {switchError && !switchTarget && (
                <p className="text-error text-xs mt-2 p-2 bg-error/10 rounded">{switchError}</p>
              )}
              {switchTarget && (
                <div className="mt-3 pt-3 border-t border-base-300">
                  <h4 className="text-sm font-semibold mb-2 text-warning">Uncommitted changes</h4>
                  <p className="text-xs text-base-content/60 mb-3">
                    Handle changes before switching to <strong>{switchTarget}</strong>:
                  </p>
                  <div className="flex flex-col gap-1.5 mb-3">
                    {([
                      { value: "commit" as const, label: "Commit", hint: "Create a new commit" },
                      { value: "amend" as const, label: "Amend", hint: "Add to last commit" },
                      { value: "stash" as const, label: "Stash", hint: "Save for later" },
                      { value: "clean" as const, label: "Discard", hint: "Delete all changes", hintClass: "text-error" },
                    ] as const).map(opt => (
                      <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 bg-base-100 border border-base-300 rounded cursor-pointer hover:border-base-content/30 text-xs">
                        <input
                          type="radio"
                          name="switchHandling"
                          value={opt.value}
                          checked={switchHandling === opt.value}
                          onChange={() => setSwitchHandling(opt.value)}
                          disabled={switchBusy}
                          className="radio radio-xs"
                        />
                        <strong>{opt.label}</strong>
                        <span className={"text-base-content/50" + ("hintClass" in opt ? ` ${opt.hintClass}` : "")}>{opt.hint}</span>
                      </label>
                    ))}
                  </div>
                  {switchHandling === "commit" && (
                    <input
                      type="text"
                      className="input input-bordered input-sm w-full mb-2"
                      value={switchCommitMsg}
                      onChange={e => setSwitchCommitMsg(e.target.value)}
                      placeholder="wip changes"
                      disabled={switchBusy}
                    />
                  )}
                  {(switchHandling === "commit" || switchHandling === "amend") && (
                    <label className="flex items-center gap-2 mb-3 cursor-pointer text-xs">
                      <input type="checkbox" className="checkbox checkbox-xs" checked={switchNoVerify} onChange={e => setSwitchNoVerify(e.target.checked)} disabled={switchBusy} />
                      Skip git hooks (--no-verify)
                    </label>
                  )}
                  {switchError && <p className="text-error text-xs mb-2 p-2 bg-error/10 rounded">{switchError}</p>}
                  <div className="flex gap-2">
                    <button className="btn btn-outline btn-primary btn-xs" onClick={handleSwitchWithChanges} disabled={switchBusy || (switchHandling === "commit" && !switchCommitMsg.trim())}>
                      {switchBusy ? "Switching..." : "Switch"}
                    </button>
                    <button className="btn btn-outline btn-neutral btn-xs" onClick={() => { setSwitchTarget(null); setSwitchError(null); }} disabled={switchBusy}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
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
            <span className="text-base-content/40 mr-1 inline-flex items-center align-middle">{statusCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
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
            <p className="text-neutral-content/60 italic m-0">Loading...</p>
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
                  <span key={`untracked-${file}`} className="text-neutral-content/70">?  {file}{"\n"}</span>
                )),
                ...gitStatus.deleted.map((file) => (
                  <span key={`deleted-${file}`} className="text-error">D  {file}{"\n"}</span>
                )),
                ...gitStatus.created.map((file) => (
                  <span key={`created-${file}`} className="text-success">A  {file}{"\n"}</span>
                )),
              ]}</code></pre>
              {gitStatus.truncated && (
                <div className="text-warning text-xs mt-2 p-2 bg-warning/10 rounded">
                  Showing {gitStatus.staged.length + gitStatus.modified.length + gitStatus.not_added.length + gitStatus.deleted.length + gitStatus.created.length} of {gitStatus.totalFiles} files - too many to display in full.
                </div>
              )}
            </div>
          ) : gitStatus ? (
            <p className="text-success m-0">Working tree clean</p>
          ) : (
            <p className="text-neutral-content/60 italic m-0">Failed to load status</p>
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
