import React, { useEffect, useMemo, useState } from "react";
import { ProjectEntry, ProjectNode, FsEntry, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import { relativeToRoot } from "../paths";
import CommandPalette, { PaletteItem } from "./CommandPalette";

type Mode = "quickOpen" | "commands";

// Wires the projects screen to the generic CommandPalette: Cmd+P opens quick
// open (fuzzy file search across all projects, opening the chosen file in the
// editor and switching to its project), Cmd+Shift+P opens the command palette
// (contextual actions on the selected project node). Always mounted on the
// projects screen so the shortcuts are live even while the palette is closed.
const ProjectsPalette: React.FC<{
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onOpenFile: (file: OpenFile, projectPath: string, projectName: string) => void;
  onNewTerminal: () => void;
}> = ({ projects, selectedNode, onOpenFile, onNewTerminal }) => {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [fileResults, setFileResults] = useState<{ entry: FsEntry; project: ProjectEntry }[]>([]);

  const close = () => setMode(null);

  // Cmd/Ctrl+P -> quick open, Cmd/Ctrl+Shift+P -> commands. Works whether the
  // palette is open or closed, so the two shortcuts also switch between modes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyP") return;
      e.preventDefault();
      setMode(e.shiftKey ? "commands" : "quickOpen");
      setQuery("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Recursive file search across every project (debounced) while quick open is
  // active. fs.search returns matching entries plus ancestor dirs for tree
  // rendering, so keep only files whose own name matches the query.
  useEffect(() => {
    if (mode !== "quickOpen") return;
    const q = query.trim().toLowerCase();
    if (!q) {
      setFileResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const perProject = await Promise.all(
          projects.map((p) =>
            getRpcClient().query("fs.search", { dirPath: p.path, query: q }).then((rec) => ({ project: p, rec })),
          ),
        );
        if (cancelled) return;
        const seen = new Set<string>();
        const files: { entry: FsEntry; project: ProjectEntry }[] = [];
        for (const { project, rec } of perProject) {
          for (const entries of Object.values(rec)) {
            for (const entry of entries) {
              if (entry.isDirectory || seen.has(entry.path)) continue;
              if (!entry.name.toLowerCase().includes(q)) continue;
              seen.add(entry.path);
              files.push({ entry, project });
            }
          }
        }
        files.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
        setFileResults(files.slice(0, 100));
      } catch (err) {
        if (!cancelled) {
          console.error("[palette] file search failed:", err);
          setFileResults([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, query, projects]);

  const runAction = (rpc: () => Promise<unknown>) => {
    rpc().catch((err) => console.error("[palette] action failed:", err));
    close();
  };

  // Contextual actions, available once a project node is selected.
  const commands = useMemo<PaletteItem[]>(() => {
    if (!selectedNode) return [];
    const path = selectedNode.path;
    return [
      { id: "new-terminal", label: "New Terminal Pane", onSelect: () => { onNewTerminal(); close(); } },
      { id: "open-terminal", label: "Open in Terminal (external)", onSelect: () => runAction(() => getRpcClient().query("action.openTerminalInDir", { path })) },
      { id: "open-folder", label: "Open Folder (external)", onSelect: () => runAction(() => getRpcClient().query("action.openDirectory", { path })) },
      { id: "open-editor", label: "Open in Editor (external)", onSelect: () => runAction(() => getRpcClient().query("action.openEditor", { path })) },
    ];
  }, [selectedNode, onNewTerminal]);

  const items = useMemo<PaletteItem[]>(() => {
    if (mode === "quickOpen") {
      return fileResults.map(({ entry, project }) => ({
        id: entry.path,
        label: entry.name,
        detail: relativeToRoot(entry.path, project.path),
        onSelect: () => {
          onOpenFile({ path: entry.path, name: entry.name }, project.path, project.name);
          close();
        },
      }));
    }
    const q = query.trim().toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [mode, fileResults, query, commands, onOpenFile]);

  if (mode === null) return null;

  return (
    <CommandPalette
      placeholder={mode === "quickOpen" ? "Search files by name..." : "Type a command..."}
      query={query}
      onQueryChange={setQuery}
      items={items}
      loading={mode === "quickOpen" && searching}
      emptyText={
        mode === "quickOpen"
          ? query.trim()
            ? "No matching files"
            : "Type to search files"
          : selectedNode
            ? "No matching commands"
            : "Select a project first"
      }
      onClose={close}
    />
  );
};

export default ProjectsPalette;
