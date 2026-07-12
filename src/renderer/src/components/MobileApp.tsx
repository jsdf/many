import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Menu, X, ChevronRight, ChevronDown, RotateCw } from "lucide-react";
import { getRpcClient } from "../rpc-client";
import type { ProjectEntry } from "../types";
import ClaudeUiTab from "./ClaudeUiTab";

// Unified recent Claude session, merged across all projects and worktrees.
interface RecentSession {
  sessionId: string;
  worktreePath: string;
  firstPrompt: string;
  summary?: string;
  modified: string;
  gitBranch: string;
  sessionType?: "chat" | "claude-code";
}

interface SelectedSession {
  sessionId: string;
  worktreePath: string;
  label: string;
}

// Mobile routing: the open session lives in the URL as /mobile/sessions/<id> so
// a reload (or a shared link) restores it. Segments after /mobile select the
// sub-view, leaving room for other mobile UIs in future.
function parseMobileRoute(pathname: string): { sessionId: string | null } {
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts[1] === "sessions" && parts[2]) return { sessionId: parts[2] };
  return { sessionId: null };
}

// Push a new mobile route, preserving the query string (auth token).
function navigateMobile(sessionId: string | null) {
  const base = sessionId ? `/mobile/sessions/${sessionId}` : "/mobile";
  const next = base + window.location.search;
  if (window.location.pathname + window.location.search !== next) {
    window.history.pushState(null, "", next);
  }
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sessionLabel(s: RecentSession): string {
  return (s.summary || s.firstPrompt || "").replace(/<[^>]+>/g, "").trim() || "Claude session";
}

function TypeBadge({ type }: { type?: "chat" | "claude-code" }) {
  if (type === "chat") return <span className="badge badge-info badge-xs shrink-0">chat</span>;
  if (type === "claude-code") return <span className="badge badge-neutral badge-xs shrink-0">cli</span>;
  return null;
}

// The Claude UI session is server-owned. Resume the on-disk conversation
// (idempotent if it is already live) before rendering the panel, which then
// attaches to it and replays the transcript.
function MobileSession({ sessionId, worktreePath }: { sessionId: string; worktreePath: string }) {
  const [resumed, setResumed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResumed(false);
    setError(null);
    getRpcClient()
      .query("claudeui.resume", { worktreePath, sessionId })
      .then(() => {
        if (!cancelled) setResumed(true);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, worktreePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error text-sm px-6 text-center">
        {error}
      </div>
    );
  }
  if (!resumed) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="loading loading-spinner loading-md" />
      </div>
    );
  }
  return <ClaudeUiTab sessionId={sessionId} />;
}

export default function MobileApp() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [routeSessionId, setRouteSessionId] = useState<string | null>(
    () => parseMobileRoute(window.location.pathname).sessionId,
  );
  // Open the drawer by default only when no session is in the URL.
  const [drawerOpen, setDrawerOpen] = useState(() => routeSessionId === null);
  const [mode, setMode] = useState<"sessions" | "folders">("sessions");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Keep route state in sync with browser back/forward.
  useEffect(() => {
    const onPopState = () => setRouteSessionId(parseMobileRoute(window.location.pathname).sessionId);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const loadSessions = useCallback(async (roots: string[]) => {
    if (roots.length === 0) {
      setSessions([]);
      setLoading(false);
      return;
    }
    try {
      const result = await getRpcClient().query("claude.recentSessions", {
        rootPaths: roots,
        limit: 50,
      });
      setSessions(result);
    } catch (err) {
      console.error("Failed to load recent sessions:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load projects once, then sessions for those project roots.
  useEffect(() => {
    let cancelled = false;
    getRpcClient()
      .query("projects.list", {})
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        loadSessions(list.map((p) => p.path));
      })
      .catch((err) => {
        console.error("Failed to load projects:", err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  // Refresh the recent list while the drawer is open so active sessions surface.
  useEffect(() => {
    if (!drawerOpen) return;
    const roots = projects.map((p) => p.path);
    const interval = setInterval(() => loadSessions(roots), 4000);
    return () => clearInterval(interval);
  }, [drawerOpen, projects, loadSessions]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0)),
    [sessions],
  );

  // Folders view: group recent sessions by their containing project (matching
  // the desktop Projects tab), ordered by the most recent session in each.
  // Sessions in a worktree under a project roll up to that project; sessions not
  // under any configured project fall back to grouping by their worktree path.
  const folders = useMemo(() => {
    const findProject = (wp: string) => {
      const sep = wp.includes("\\") ? "\\" : "/";
      return projects.find((pr) => wp === pr.path || wp.startsWith(pr.path + sep));
    };
    const byKey = new Map<string, { name: string; sessions: RecentSession[] }>();
    for (const s of sortedSessions) {
      const project = findProject(s.worktreePath);
      const key = project ? project.path : s.worktreePath;
      const name = project ? project.name : baseName(s.worktreePath);
      const group = byKey.get(key) ?? { name, sessions: [] };
      group.sessions.push(s);
      byKey.set(key, group);
    }
    return Array.from(byKey.entries()).map(([path, { name, sessions }]) => ({
      path,
      name,
      sessions,
      recency: Date.parse(sessions[0]?.modified ?? "") || 0,
    }));
  }, [sortedSessions, projects]);

  // The open session is derived from the route, resolved against the loaded
  // list to recover its worktree (the chat needs it) and label.
  const selected = useMemo<SelectedSession | null>(() => {
    if (!routeSessionId) return null;
    const s = sessions.find((x) => x.sessionId === routeSessionId);
    if (!s) return null;
    return { sessionId: s.sessionId, worktreePath: s.worktreePath, label: sessionLabel(s) };
  }, [routeSessionId, sessions]);

  const selectSession = useCallback((s: RecentSession) => {
    navigateMobile(s.sessionId);
    setRouteSessionId(s.sessionId);
    setDrawerOpen(false);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const headerTitle = selected ? selected.label : "Many";

  return (
    <div className="flex flex-col h-screen bg-base-100 overflow-hidden">
      {/* Top bar (pad past the notch / sensor housing) */}
      <div className="border-b border-base-300 shrink-0 bg-base-200/50 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-2 px-3 h-12">
          <button className="btn btn-ghost btn-sm btn-square" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <span className="font-semibold text-sm truncate flex-1">{headerTitle}</span>
        </div>
      </div>

      {/* Main: chat or empty state */}
      <div className="flex-1 min-h-0">
        {selected ? (
          <MobileSession
            key={selected.sessionId}
            worktreePath={selected.worktreePath}
            sessionId={selected.sessionId}
          />
        ) : routeSessionId && loading ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : routeSessionId ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-base-content/40 px-6 text-center">
            <p className="text-sm">Session not found in recent list.</p>
            <button className="btn btn-outline btn-primary btn-sm" onClick={() => setDrawerOpen(true)}>
              <Menu size={16} /> Browse sessions
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-base-content/40 px-6 text-center">
            <p className="text-sm">No session selected.</p>
            <button className="btn btn-outline btn-primary btn-sm" onClick={() => setDrawerOpen(true)}>
              <Menu size={16} /> Browse sessions
            </button>
          </div>
        )}
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="w-[85%] max-w-sm h-full bg-base-100 flex flex-col shadow-xl border-r border-base-300 pt-[env(safe-area-inset-top)]">
            {/* Drawer header */}
            <div className="flex items-center gap-2 px-3 h-12 border-b border-base-300 shrink-0">
              <span className="font-semibold text-sm flex-1">Sessions</span>
              <button
                className="btn btn-ghost btn-xs btn-square"
                onClick={() => loadSessions(projects.map((p) => p.path))}
                aria-label="Refresh"
              >
                <RotateCw size={14} />
              </button>
              <button
                className="btn btn-ghost btn-xs btn-square"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <X size={16} />
              </button>
            </div>

            {/* Sessions / Folders toggle */}
            <div className="p-2 shrink-0 border-b border-base-300">
              <div className="join w-full">
                <button
                  className={`btn btn-sm join-item flex-1 ${mode === "sessions" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setMode("sessions")}
                >
                  Sessions
                </button>
                <button
                  className={`btn btn-sm join-item flex-1 ${mode === "folders" ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setMode("folders")}
                >
                  Folders
                </button>
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-2">
              {loading && sessions.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <span className="loading loading-spinner loading-md" />
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-base-content/50 text-xs text-center mt-4">No recent Claude sessions.</p>
              ) : mode === "sessions" ? (
                <div className="flex flex-col gap-2">
                  {sortedSessions.map((s) => (
                    <SessionCard
                      key={s.sessionId}
                      session={s}
                      active={routeSessionId === s.sessionId}
                      showFolder
                      onClick={() => selectSession(s)}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {folders.map((folder) => {
                    const open = expandedFolders.has(folder.path);
                    return (
                      <div key={folder.path} className="flex flex-col">
                        <button
                          className="flex items-center gap-2 px-2 py-2 text-left rounded-lg hover:bg-base-200 min-w-0"
                          onClick={() => toggleFolder(folder.path)}
                        >
                          <span className="shrink-0 opacity-50">
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                          <span className="font-medium text-sm truncate flex-1 min-w-0">{folder.name}</span>
                          <span className="text-xs text-base-content/30 shrink-0">{folder.sessions.length}</span>
                        </button>
                        {open && (
                          <div className="flex flex-col gap-2 pl-4 pt-1">
                            {folder.sessions.map((s) => (
                              <SessionCard
                                key={s.sessionId}
                                session={s}
                                active={routeSessionId === s.sessionId}
                                showFolder
                                onClick={() => selectSession(s)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Scrim */}
          <div className="flex-1 bg-black/40" onClick={() => setDrawerOpen(false)} />
        </div>
      )}
    </div>
  );
}

function SessionCard({
  session,
  active,
  showFolder,
  onClick,
}: {
  session: RecentSession;
  active: boolean;
  showFolder?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`text-left bg-base-200 border rounded-lg p-3 cursor-pointer ${
        active ? "border-primary" : "border-base-300 hover:border-primary/50"
      }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <TypeBadge type={session.sessionType} />
        {showFolder && (
          <span className="text-xs text-base-content/50 font-medium truncate min-w-0">
            {baseName(session.worktreePath)}
          </span>
        )}
        {session.gitBranch && (
          <span className="text-xs text-base-content/40 font-mono truncate min-w-0">{session.gitBranch}</span>
        )}
        <span className="text-xs text-base-content/40 shrink-0 ml-auto">{formatAge(session.modified)}</span>
      </div>
      <p className="text-sm text-base-content/80 m-0 line-clamp-2">{sessionLabel(session)}</p>
    </button>
  );
}
