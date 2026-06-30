import React, { useState, useEffect, useCallback } from "react";
import { getRpcClient } from "../rpc-client";
import SessionHistoryTab from "./SessionHistoryTab";
import { ArrowLeft, RotateCw } from "lucide-react";

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

interface ProjectSessionsTabProps {
  worktreePath: string;
  onResumeSession?: (sessionId: string, target: "ui" | "terminal") => void;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const ProjectSessionsTab: React.FC<ProjectSessionsTabProps> = ({ worktreePath, onResumeSession }) => {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await getRpcClient().query("claude.sessions", { worktreePath })) as ClaudeSession[];
      setSessions(result);
    } catch (err) {
      console.error("Failed to load claude sessions:", err);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [worktreePath]);

  useEffect(() => {
    setOpenSessionId(null);
    load();
  }, [load]);

  if (openSessionId) {
    return (
      <div className="h-full flex flex-col bg-base-100">
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-base-300 shrink-0">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setOpenSessionId(null)}
          >
            <ArrowLeft size={12} /> Sessions
          </button>
          <span className="text-xs text-base-content/40 font-mono">{openSessionId.slice(0, 8)}</span>
        </div>
        <div className="flex-1 min-h-0">
          <SessionHistoryTab sessionId={openSessionId} worktreePath={worktreePath} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-base-100">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-base-300 shrink-0">
        <span className="text-xs font-semibold text-base-content/60">
          Sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
        </span>
        <button className="btn btn-ghost btn-xs" onClick={load} title="Refresh">
          <RotateCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-base-content/50 text-xs text-center mt-4">
            No Claude sessions for this directory.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((session) => (
              <div
                key={session.sessionId}
                className="text-left bg-base-200 border border-base-300 rounded-lg p-3 hover:border-primary/50 cursor-pointer"
                onClick={() => setOpenSessionId(session.sessionId)}
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
                  {(session.summary || session.firstPrompt || "").replace(/<[^>]+>/g, "").trim() || (
                    <span className="italic text-base-content/40">No prompt</span>
                  )}
                </p>
                {onResumeSession && (
                  <div className="flex justify-end gap-2 mt-2">
                    <button
                      className="btn btn-soft btn-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResumeSession(session.sessionId, "ui");
                      }}
                    >
                      Resume (UI)
                    </button>
                    <button
                      className="btn btn-soft btn-primary btn-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onResumeSession(session.sessionId, "terminal");
                      }}
                    >
                      Resume (term)
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectSessionsTab;
