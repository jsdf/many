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

// Worktree quick-open palette. Cmd+K opens it app-wide. Always mounted so the
// shortcut is captured even when a terminal pane has focus.
const WorktreePalette: React.FC<{
  worktrees: Worktree[];
  onWorktreeSelect: (worktree: Worktree) => void;
}> = ({ worktrees, onWorktreeSelect }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== "KeyK") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((prev) => !prev);
      setQuery("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const fzf = useMemo(
    () => new Fzf(worktrees, { selector: (w) => `${w.branch ?? ""} ${w.worktreeName}`, limit: 50 }),
    [worktrees],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const results = q
      ? fzf.find(q)
      : worktrees.map((w) => ({ item: w, positions: new Set<number>() }));
    return results.map(({ item: w, positions }) => {
      const branch = w.branch ?? "(no branch)";
      const displayBranch = formatBranchName(branch);
      const branchPositions = new Set<number>();
      // positions are over the combined selector string; extract only the branch part
      for (const p of positions) {
        if (p < branch.length) branchPositions.add(p);
      }
      return {
        id: w.path,
        label: highlight(displayBranch, branchPositions),
        detail: w.worktreeName,
        onSelect: () => {
          onWorktreeSelect(w);
          setOpen(false);
        },
      };
    });
  }, [query, fzf, worktrees, onWorktreeSelect]);

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
