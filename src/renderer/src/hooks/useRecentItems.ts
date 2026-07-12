import { useCallback, useEffect, useMemo, useState } from "react";
import { getRpcClient } from "../rpc-client";
import { ProjectEntry } from "../types";

// Unified "recent" item: a project-attached terminal or a recent Claude
// session for one of those projects.
export type RecentItem =
  | { kind: "terminal"; recency: number; terminalId: string; worktreePath: string; title?: string; terminalNumber: number; claudeSessionId?: string }
  | { kind: "claude"; recency: number; sessionId: string; worktreePath: string; sessionType?: "chat" | "claude-code"; label: string };

// Polls the live terminals and recent Claude sessions while `activeMode` is
// "recent", and derives the unified, pin-sorted recent list (newest first)
// for the Active pane's sessions view.
export function useRecentItems(
  projects: ProjectEntry[],
  activeMode: "byFolder" | "recent",
  pinnedSessions: string[],
): RecentItem[] {
  const [recentTerminals, setRecentTerminals] = useState<
    { terminalId: string; worktreePath: string; createdAt: number; lastInputAt: number; title?: string; claudeSessionId?: string }[]
  >([]);
  const [recentSessions, setRecentSessions] = useState<
    { sessionId: string; worktreePath: string; firstPrompt: string; summary?: string; modified: string; gitBranch: string; sessionType?: "chat" | "claude-code" }[]
  >([]);

  // Poll the live terminals and recent Claude sessions while showing the
  // "recent" view. A terminal's recency is the newer of its last user input and
  // its creation; a session's is its last-modified time.
  useEffect(() => {
    if (activeMode !== "recent") return;
    let cancelled = false;
    const poll = async () => {
      const client = getRpcClient();
      const rootPaths = projects.map((p) => p.path);
      try {
        const [terminals, sessions] = await Promise.all([
          client.query("terminal.listAll", {}),
          client.query("claude.recentSessions", { rootPaths, limit: 10 }),
        ]);
        if (!cancelled) {
          setRecentTerminals(terminals);
          setRecentSessions(sessions);
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeMode, projects]);

  // A path belongs to a project when it is, or is nested under, a project root.
  const isUnderAnyProject = useCallback(
    (p: string) => {
      const sep = p.includes("\\") ? "\\" : "/";
      return projects.some((pr) => p === pr.path || p.startsWith(pr.path + sep));
    },
    [projects],
  );

  const pinnedSessionSet = useMemo(() => new Set(pinnedSessions), [pinnedSessions]);

  const recentItems = useMemo<RecentItem[]>(() => {
    // Assign stable per-worktree numbers to terminals by creation order so that
    // multiple terminals in the same folder are distinguishable in the list.
    const byWorktree = new Map<string, { terminalId: string; createdAt: number }[]>();
    for (const t of recentTerminals) {
      if (!isUnderAnyProject(t.worktreePath)) continue;
      const group = byWorktree.get(t.worktreePath) ?? [];
      group.push({ terminalId: t.terminalId, createdAt: t.createdAt });
      byWorktree.set(t.worktreePath, group);
    }
    const terminalNumbers = new Map<string, number>();
    for (const group of byWorktree.values()) {
      group.sort((a, b) => a.createdAt - b.createdAt);
      group.forEach(({ terminalId }, idx) => terminalNumbers.set(terminalId, idx + 1));
    }

    const items: RecentItem[] = [];
    // Session ids already live in a terminal, so a discovered session with the
    // same id is the same conversation and shouldn't appear as a second item.
    const terminalSessionIds = new Set<string>();
    for (const t of recentTerminals) {
      if (!isUnderAnyProject(t.worktreePath)) continue;
      if (t.claudeSessionId) terminalSessionIds.add(t.claudeSessionId);
      items.push({
        kind: "terminal",
        recency: Math.max(t.lastInputAt, t.createdAt),
        terminalId: t.terminalId,
        worktreePath: t.worktreePath,
        title: t.title,
        terminalNumber: terminalNumbers.get(t.terminalId) ?? 1,
        claudeSessionId: t.claudeSessionId,
      });
    }
    for (const s of recentSessions) {
      if (terminalSessionIds.has(s.sessionId)) continue;
      items.push({
        kind: "claude",
        recency: Date.parse(s.modified) || 0,
        sessionId: s.sessionId,
        worktreePath: s.worktreePath,
        sessionType: s.sessionType,
        label: (s.summary || s.firstPrompt || "").replace(/<[^>]+>/g, "").trim() || "Claude session",
      });
    }
    const keyOf = (it: RecentItem) => (it.kind === "terminal" ? `t:${it.terminalId}` : `c:${it.sessionId}`);
    return items.sort((a, b) => {
      const ap = pinnedSessionSet.has(keyOf(a)) ? 0 : 1;
      const bp = pinnedSessionSet.has(keyOf(b)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.recency - a.recency;
    });
  }, [recentTerminals, recentSessions, isUnderAnyProject, pinnedSessionSet]);

  return recentItems;
}
