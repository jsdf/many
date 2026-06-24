import React, { useEffect, useMemo, useState } from "react";
import { Fzf } from "fzf";
import { ProjectEntry, ProjectNode, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import { useFileEditors } from "../useFileEditors";
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

type Mode = "quickOpen" | "commands";

const FILE_LIMIT = 200;

// Wires the projects screen to the generic CommandPalette. Cmd+P opens quick
// open (fzf fuzzy file search across all projects); Cmd+Shift+P opens the
// command palette (contextual actions on the selected project node). File
// results are ranked by context: the focused file's directory first, then the
// selected node's subtree, then everything else. Always mounted so the
// shortcuts are claimed app-wide even when closed.
const ProjectsPalette: React.FC<{
  active: boolean;
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onOpenFile: (file: OpenFile, projectPath: string, projectName: string) => void;
  onNewTerminal: () => void;
}> = ({ active, projects, selectedNode, onOpenFile, onNewTerminal }) => {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");

  const close = () => setMode(null);

  // The projects screen's Cmd+P behavior: Cmd+P -> file quick open,
  // Cmd+Shift+P -> commands. Only registered while the projects screen is
  // active; other screens register their own Cmd+P (App mounts a global
  // fallback that suppresses the browser print dialog regardless).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyP") return;
      e.preventDefault();
      e.stopPropagation();
      setMode(e.shiftKey ? "commands" : "quickOpen");
      setQuery("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  // Close the palette if we leave the projects screen while it is open.
  useEffect(() => {
    if (!active) setMode(null);
  }, [active]);

  const roots = useMemo<PaletteRoot[]>(
    () => projects.map((p) => ({ path: p.path, label: p.name })),
    [projects],
  );
  const { files, loading } = usePaletteFiles(roots, mode === "quickOpen");
  const fileFzf = useMemo(
    () => (files ? new Fzf(files, { selector: (f) => f.rel }) : null),
    [files],
  );

  // Contextual ranking: the directory of the file focused in the selected
  // project's editor, then the selected node's subtree.
  const { openFiles, activeFile } = useFileEditors(selectedNode?.path ?? null, "");
  const boosts = useMemo<Boost[]>(() => {
    const out: Boost[] = [];
    const focused = openFiles.find((f) => f.path === activeFile);
    if (focused) out.push({ dir: dirName(focused.path), mode: "exactDir" });
    if (selectedNode) out.push({ dir: selectedNode.path, mode: "subtree" });
    return out;
  }, [openFiles, activeFile, selectedNode]);

  const fileItem = (f: PaletteFile, positions: Set<number>): PaletteItem => ({
    id: f.abs,
    label: highlight(f.rel, positions),
    detail: projects.length > 1 ? f.rootLabel : undefined,
    onSelect: () => {
      onOpenFile({ path: f.abs, name: f.name }, f.rootPath, f.rootLabel);
      close();
    },
  });

  // Contextual actions, available once a project node is selected.
  const commandDefs = useMemo(() => {
    if (!selectedNode) return [] as { id: string; text: string; run: () => void }[];
    const path = selectedNode.path;
    const action = (rpc: () => Promise<unknown>) => () => {
      rpc().catch((err) => console.error("[palette] action failed:", err));
      close();
    };
    return [
      { id: "new-terminal", text: "New Terminal Pane", run: () => { onNewTerminal(); close(); } },
      { id: "open-terminal", text: "Open in Terminal (external)", run: action(() => getRpcClient().query("action.openTerminalInDir", { path })) },
      { id: "open-folder", text: "Open Folder (external)", run: action(() => getRpcClient().query("action.openDirectory", { path })) },
      { id: "open-editor", text: "Open in Editor (external)", run: action(() => getRpcClient().query("action.openEditor", { path })) },
    ];
  }, [selectedNode, onNewTerminal]);

  const commandFzf = useMemo(() => new Fzf(commandDefs, { selector: (c) => c.text }), [commandDefs]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (mode === "quickOpen") {
      if (!files || !fileFzf) return [];
      return rankFiles(q, files, fileFzf, boosts, FILE_LIMIT).map(({ file, positions }) => fileItem(file, positions));
    }
    const ranked = q
      ? commandFzf.find(q)
      : commandDefs.map((c) => ({ item: c, positions: new Set<number>() }));
    return ranked.map(({ item, positions }) => ({
      id: item.id,
      label: highlight(item.text, positions),
      onSelect: item.run,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, files, fileFzf, boosts, commandFzf, commandDefs, projects.length]);

  if (mode === null) return null;

  return (
    <CommandPalette
      placeholder={mode === "quickOpen" ? "Search files by name..." : "Type a command..."}
      query={query}
      onQueryChange={setQuery}
      items={items}
      loading={mode === "quickOpen" && loading && !files}
      emptyText={
        mode === "quickOpen"
          ? "No matching files"
          : selectedNode
            ? "No matching commands"
            : "Select a project first"
      }
      onClose={close}
    />
  );
};

export default ProjectsPalette;
