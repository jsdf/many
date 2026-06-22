import React, { useEffect, useMemo, useState } from "react";
import { Fzf } from "fzf";
import { Worktree, formatBranchName } from "../types";
import CommandPalette, { PaletteItem } from "./CommandPalette";

function highlight(text: string, positions: Set<number>): React.ReactNode {
  if (positions.size === 0) return text;
  const parts: React.ReactNode[] = [];
  let run = "";
  let runHi = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(
      runHi ? (
        <span key={key} className="text-primary font-semibold">{run}</span>
      ) : (
        <span key={key}>{run}</span>
      ),
    );
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hi = positions.has(i);
    if (hi !== runHi) {
      flush(i);
      runHi = hi;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

type Entry = { wt: Worktree; branch: string };

// Cmd+P quick-open for worktrees. Registered only while `active` (App gates it
// to every screen except the projects screen, which uses Cmd+P for files). App
// also mounts a global fallback that suppresses the browser print dialog, so
// this handler only needs to implement behavior.
const WorktreePalette: React.FC<{
  active: boolean;
  worktrees: Worktree[];
  onWorktreeSelect: (worktree: Worktree) => void;
}> = ({ active, worktrees, onWorktreeSelect }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== "KeyP") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      setQuery("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  // Close if the palette is open when the screen becomes inactive.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  const entries = useMemo<Entry[]>(
    () => worktrees.map((wt) => ({ wt, branch: formatBranchName(wt.branch) })),
    [worktrees],
  );

  // Match against the formatted branch so highlight positions line up with the
  // displayed label; worktree name is shown as detail.
  const fzf = useMemo(() => new Fzf(entries, { selector: (e) => e.branch, limit: 50 }), [entries]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const results = q
      ? fzf.find(q)
      : entries.map((e) => ({ item: e, positions: new Set<number>() }));
    return results.map(({ item: e, positions }) => ({
      id: e.wt.path,
      label: highlight(e.branch, positions),
      detail: e.wt.worktreeName,
      onSelect: () => {
        onWorktreeSelect(e.wt);
        setOpen(false);
      },
    }));
  }, [query, fzf, entries, onWorktreeSelect]);

  if (!open) return null;

  return (
    <CommandPalette
      placeholder="Jump to worktree..."
      query={query}
      onQueryChange={setQuery}
      items={items}
      emptyText="No matching worktrees"
      onClose={() => setOpen(false)}
    />
  );
};

export default WorktreePalette;
