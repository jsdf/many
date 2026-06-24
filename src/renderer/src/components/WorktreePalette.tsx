import React, { useEffect, useMemo, useState } from "react";
import { Fzf } from "fzf";
import { Worktree, formatBranchName } from "../types";
import { useFileEditors, useOpenFile } from "../useFileEditors";
import CommandPalette, { PaletteItem } from "./CommandPalette";
import {
  Boost,
  dirName,
  highlight,
  PaletteFile,
  PaletteRoot,
  rankFiles,
  usePaletteFiles,
} from "./palette-files";

type WtEntry = { wt: Worktree; branch: string };

const FILE_LIMIT = 200;

// Cmd+P quick-open for every screen except the projects screen (which uses
// Cmd+P for its own file palette). One palette holds both: worktrees to jump
// to (matched on branch name) and the current worktree's files to open
// (prefixed with the worktree name). Files are ranked by context - the focused
// file's directory first, then the rest of the current worktree. App also
// mounts a global fallback that suppresses the browser print dialog, so this
// handler only implements behavior.
const WorktreePalette: React.FC<{
  active: boolean;
  worktrees: Worktree[];
  selectedWorktree: Worktree | null;
  onWorktreeSelect: (worktree: Worktree) => void;
  onFileOpened: () => void;
}> = ({ active, worktrees, selectedWorktree, onWorktreeSelect, onFileOpened }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openFileInRoot = useOpenFile();

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

  // Worktree-jump entries, matched on the formatted branch so highlight
  // positions line up with the displayed label.
  const wtEntries = useMemo<WtEntry[]>(
    () => worktrees.map((wt) => ({ wt, branch: formatBranchName(wt.branch) })),
    [worktrees],
  );
  const wtFzf = useMemo(() => new Fzf(wtEntries, { selector: (e) => e.branch }), [wtEntries]);

  // Files of the current worktree only (scope is intentionally one worktree).
  const roots = useMemo<PaletteRoot[]>(
    () => (selectedWorktree ? [{ path: selectedWorktree.path, label: selectedWorktree.worktreeName }] : []),
    [selectedWorktree],
  );
  const { files } = usePaletteFiles(roots, open && !!selectedWorktree);
  const fileFzf = useMemo(
    () => (files ? new Fzf(files, { selector: (f) => f.rel }) : null),
    [files],
  );

  // Contextual ranking: the directory of the focused file in this worktree,
  // then the rest of the worktree.
  const { openFiles, activeFile } = useFileEditors(selectedWorktree?.path ?? null, "");
  const boosts = useMemo<Boost[]>(() => {
    const out: Boost[] = [];
    const focused = openFiles.find((f) => f.path === activeFile);
    if (focused) out.push({ dir: dirName(focused.path), mode: "exactDir" });
    if (selectedWorktree) out.push({ dir: selectedWorktree.path, mode: "subtree" });
    return out;
  }, [openFiles, activeFile, selectedWorktree]);

  const fileItem = (f: PaletteFile, positions: Set<number>): PaletteItem => ({
    id: "file:" + f.abs,
    label: (
      <>
        <span className="text-base-content/40">{f.rootLabel}/</span>
        {highlight(f.rel, positions)}
      </>
    ),
    onSelect: () => {
      openFileInRoot(f.rootPath, { path: f.abs, name: f.name });
      onFileOpened();
      setOpen(false);
    },
  });

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();

    // Worktrees first (the familiar quick-switch), then files below.
    const wtResults = q
      ? wtFzf.find(q)
      : wtEntries.map((e) => ({ item: e, positions: new Set<number>() }));
    const wtItems: PaletteItem[] = wtResults.map(({ item: e, positions }) => ({
      id: "wt:" + e.wt.path,
      label: highlight(e.branch, positions),
      detail: e.wt.worktreeName,
      onSelect: () => {
        onWorktreeSelect(e.wt);
        setOpen(false);
      },
    }));

    const fileItems: PaletteItem[] =
      files && fileFzf
        ? rankFiles(q, files, fileFzf, boosts, FILE_LIMIT).map((r) => fileItem(r.file, r.positions))
        : [];

    return [...wtItems, ...fileItems];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, wtFzf, wtEntries, files, fileFzf, boosts]);

  if (!open) return null;

  return (
    <CommandPalette
      placeholder="Search files, or jump to a worktree..."
      query={query}
      onQueryChange={setQuery}
      items={items}
      emptyText="No matching files or worktrees"
      onClose={() => setOpen(false)}
    />
  );
};

export default WorktreePalette;
