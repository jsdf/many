export type WorktreeActivity = { terminals: number; claudeSessions: number };

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");

// Sum activity for a directory: its own counts plus every descendant's, since
// terminals/sessions are keyed by the exact directory they run in. This rolls
// the counts up to any ancestor folder.
export function sumActivityUnder(
  activity: Record<string, WorktreeActivity> | undefined,
  dirPath: string,
): WorktreeActivity {
  const out: WorktreeActivity = { terminals: 0, claudeSessions: 0 };
  if (!activity) return out;
  const sep = sepOf(dirPath);
  for (const [p, a] of Object.entries(activity)) {
    if (p === dirPath || p.startsWith(dirPath + sep)) {
      out.terminals += a.terminals;
      out.claudeSessions += a.claudeSessions;
    }
  }
  return out;
}

// A folder is "in use" if it has any active terminal or Claude session.
export function isActive(a: WorktreeActivity): boolean {
  return a.terminals > 0 || a.claudeSessions > 0;
}
