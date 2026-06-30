import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ProcEntry {
  pid: number;
  ppid: number;
  rssKb: number;
}

// Parse `ps -axo pid=,ppid=,rss=` output. Whitespace-separated columns.
// Skip blank/malformed lines. rss column is in kilobytes.
export function parsePs(output: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const rssKb = parseInt(parts[2], 10);
    if (isNaN(pid) || isNaN(ppid) || isNaN(rssKb)) continue;
    entries.push({ pid, ppid, rssKb });
  }
  return entries;
}

// For each rootPid, sum RSS (bytes) over the root and ALL descendants,
// and count processes in the subtree. Builds a ppid->children map once (O(n)),
// then DFS each root. Guards against cycles with a visited set.
// Returns Map<rootPid, { memoryBytes: number; processCount: number }>.
export function sumSubtreeMemory(
  entries: ProcEntry[],
  rootPids: number[]
): Map<number, { memoryBytes: number; processCount: number }> {
  // Build pid->rssKb and ppid->children maps
  const pidToRss = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const e of entries) {
    pidToRss.set(e.pid, e.rssKb);
    if (!children.has(e.ppid)) children.set(e.ppid, []);
    children.get(e.ppid)!.push(e.pid);
  }

  const result = new Map<number, { memoryBytes: number; processCount: number }>();

  for (const rootPid of rootPids) {
    let memoryBytes = 0;
    let processCount = 0;
    const visited = new Set<number>();
    const stack = [rootPid];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (visited.has(pid)) continue; // guard against cycles
      visited.add(pid);
      const rss = pidToRss.get(pid);
      if (rss !== undefined) {
        memoryBytes += rss * 1024;
        processCount++;
      }
      const kids = children.get(pid);
      if (kids) {
        for (const kid of kids) stack.push(kid);
      }
    }
    result.set(rootPid, { memoryBytes, processCount });
  }

  return result;
}

// Run `ps` and return stats for the given root pids. On win32 or on any
// error (ps missing/fails), return an empty Map (feature degrades silently;
// it's a best-effort live gauge).
export async function getProcessMemoryStats(
  rootPids: number[]
): Promise<Map<number, { memoryBytes: number; processCount: number }>> {
  if (process.platform === "win32" || rootPids.length === 0) {
    return new Map();
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
    const entries = parsePs(stdout);
    return sumSubtreeMemory(entries, rootPids);
  } catch {
    return new Map();
  }
}
