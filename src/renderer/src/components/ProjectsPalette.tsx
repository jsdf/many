import React, { useEffect, useMemo, useRef, useState } from "react";
import { Fzf } from "fzf";
import { ProjectEntry, ProjectNode, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import CommandPalette, { PaletteItem } from "./CommandPalette";

type Mode = "quickOpen" | "commands";

type FileEntry = { rel: string; name: string; abs: string; project: ProjectEntry };

// Render text with the fzf-matched character positions emphasized.
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

// Wires the projects screen to the generic CommandPalette. Cmd+P opens quick
// open (fzf fuzzy file search across all projects, matching letter subsequences
// of the relative path so e.g. "resk" matches "replay/skill.md"); Cmd+Shift+P
// opens the command palette (contextual actions on the selected project node).
// Always mounted so the shortcuts are claimed app-wide even when closed.
const ProjectsPalette: React.FC<{
  active: boolean;
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onOpenFile: (file: OpenFile, projectPath: string, projectName: string) => void;
  onNewTerminal: () => void;
}> = ({ active, projects, selectedNode, onOpenFile, onNewTerminal }) => {
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [allFiles, setAllFiles] = useState<FileEntry[] | null>(null);
  // Which project set the loaded file list corresponds to, so we refetch when
  // projects change but reuse the cache across palette opens otherwise.
  const loadedKeyRef = useRef<string | null>(null);

  const close = () => setMode(null);

  // Claim Cmd/Ctrl+P app-wide in the capture phase so the browser's print
  // dialog never opens, no matter which pane has focus (e.g. a terminal).
  // Cmd+P -> quick open, Cmd+Shift+P -> commands, but only on the projects
  // screen; elsewhere the key is simply swallowed. Always mounted so this
  // single handler is the only one - no per-pane listeners to conflict.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyP") return;
      e.preventDefault();
      e.stopPropagation();
      if (!active) return;
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

  // Load the flat file list for every project when quick open is first shown
  // (and whenever the project set changes). fzf then matches in-memory, so no
  // per-keystroke RPC and matches can span path segments.
  useEffect(() => {
    if (mode !== "quickOpen") return;
    const key = projects.map((p) => p.path).join("|");
    if (loadedKeyRef.current === key && allFiles) return;
    let cancelled = false;
    setLoadingFiles(true);
    (async () => {
      try {
        const perProject = await Promise.all(
          projects.map((p) =>
            getRpcClient().query("fs.allFiles", { dirPath: p.path }).then((rels) => ({ p, rels })),
          ),
        );
        if (cancelled) return;
        const files: FileEntry[] = [];
        for (const { p, rels } of perProject) {
          const sep = p.path.includes("\\") ? "\\" : "/";
          for (const rel of rels) {
            const name = rel.slice(Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\")) + 1);
            files.push({ rel, name, abs: p.path + sep + rel, project: p });
          }
        }
        setAllFiles(files);
        loadedKeyRef.current = key;
      } catch (err) {
        if (!cancelled) {
          console.error("[palette] failed to load file list:", err);
          setAllFiles([]);
        }
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, projects, allFiles]);

  const fileFzf = useMemo(
    () => (allFiles ? new Fzf(allFiles, { selector: (f) => f.rel, limit: 100 }) : null),
    [allFiles],
  );

  const fileItem = (f: FileEntry, positions: Set<number>): PaletteItem => ({
    id: f.abs,
    label: highlight(f.rel, positions),
    detail: projects.length > 1 ? f.project.name : undefined,
    onSelect: () => {
      onOpenFile({ path: f.abs, name: f.name }, f.project.path, f.project.name);
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
      if (!q) return (allFiles ?? []).slice(0, 100).map((f) => fileItem(f, new Set()));
      if (!fileFzf) return [];
      return fileFzf.find(q).map((r) => fileItem(r.item, r.positions));
    }
    const ranked = q
      ? commandFzf.find(q)
      : commandDefs.map((c) => ({ item: c, positions: new Set<number>() }));
    return ranked.map(({ item, positions }) => ({
      id: item.id,
      label: highlight(item.text, positions),
      onSelect: item.run,
    }));
  }, [mode, query, allFiles, fileFzf, commandFzf, commandDefs]);

  if (mode === null) return null;

  return (
    <CommandPalette
      placeholder={mode === "quickOpen" ? "Search files by name..." : "Type a command..."}
      query={query}
      onQueryChange={setQuery}
      items={items}
      loading={mode === "quickOpen" && loadingFiles && !allFiles}
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
