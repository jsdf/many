import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ProjectEntry, ProjectNode, FsEntry, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";

interface ProjectsTabProps {
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onSelectNode: (node: ProjectNode) => void;
  onOpenFile: (file: OpenFile) => void;
  onAddProject: () => void;
  onRemoveProject: (project: ProjectEntry) => void;
}

interface TreeRow {
  entry: FsEntry;
  depth: number;
  project: ProjectEntry;
  isProject: boolean;
}

const ROW_HEIGHT = 24;

// Tree state is cached at module scope so it survives this component
// unmounting (tab switches, sidebar collapse) for the life of the page.
const treeStateCache: {
  expanded: Set<string>;
  childrenByDir: Map<string, FsEntry[]>;
} = {
  expanded: new Set(),
  childrenByDir: new Map(),
};

const ProjectsTab: React.FC<ProjectsTabProps> = ({
  projects,
  selectedNode,
  onSelectNode,
  onOpenFile,
  onAddProject,
  onRemoveProject,
}) => {
  const [expanded, setExpandedState] = useState<Set<string>>(() => treeStateCache.expanded);
  const [childrenByDir, setChildrenByDirState] = useState<Map<string, FsEntry[]>>(() => treeStateCache.childrenByDir);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  // Server-side search results, keyed by parent dir, used while filtering.
  const [searchChildren, setSearchChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const [searching, setSearching] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  // Mirror persisted state back into the module cache on every update.
  const setExpanded = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setExpandedState((prev) => (treeStateCache.expanded = updater(prev)));
  }, []);
  const setChildrenByDir = useCallback((updater: (prev: Map<string, FsEntry[]>) => Map<string, FsEntry[]>) => {
    setChildrenByDirState((prev) => (treeStateCache.childrenByDir = updater(prev)));
  }, []);

  // Live directory subscriptions, one per expanded directory. The set of
  // expanded directories is the source of truth; an effect below reconciles
  // active subscriptions against it, so toggling only updates `expanded`.
  const subsRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const client = getRpcClient();
    const subs = subsRef.current;

    // Subscribe to newly-expanded directories.
    for (const dirPath of expanded) {
      if (subs.has(dirPath)) continue;
      setLoading((prev) => new Set(prev).add(dirPath));
      const unsubscribe = client.subscribe(
        "fs.dirUpdates",
        (entries) => {
          setChildrenByDir((prev) => new Map(prev).set(dirPath, entries));
          setLoading((prev) => {
            if (!prev.has(dirPath)) return prev;
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        },
        { dirPath }
      );
      subs.set(dirPath, unsubscribe);
    }

    // Tear down subscriptions for collapsed directories.
    for (const [dirPath, unsubscribe] of subs) {
      if (expanded.has(dirPath)) continue;
      unsubscribe();
      subs.delete(dirPath);
    }
  }, [expanded, setChildrenByDir]);

  // Tear down all subscriptions on unmount.
  useEffect(() => {
    const subs = subsRef.current;
    return () => {
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    };
  }, []);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, [setExpanded]);

  // Ensure a directory is expanded without toggling it closed. Used when
  // selecting a directory, so selection also reveals its contents.
  const expandDir = useCallback((dirPath: string) => {
    setExpanded((prev) => (prev.has(dirPath) ? prev : new Set(prev).add(dirPath)));
  }, [setExpanded]);

  // Selecting a node (project root or directory) drives the main pane
  // (terminals + file tabs) and reveals its contents.
  const handleSelectNode = useCallback((node: ProjectNode) => {
    onSelectNode(node);
    expandDir(node.path);
  }, [onSelectNode, expandDir]);

  // Opening a file first switches the panel to its containing directory, then
  // opens the file there.
  const handleOpenFile = useCallback((entry: FsEntry, project: ProjectEntry) => {
    const sep = entry.path.includes("\\") ? "\\" : "/";
    const i = entry.path.lastIndexOf(sep);
    const parentPath = i >= 0 ? entry.path.slice(0, i) : project.path;
    const node: ProjectNode =
      parentPath === project.path
        ? { name: project.name, path: project.path }
        : { name: parentPath.slice(parentPath.lastIndexOf(sep) + 1), path: parentPath };
    onSelectNode(node);
    onOpenFile({ path: entry.path, name: entry.name });
  }, [onSelectNode, onOpenFile]);

  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;

  // Run a server-side recursive search (debounced) when filtering, and store
  // the matched subtree separately so the browse cache stays intact.
  useEffect(() => {
    if (!filtering) {
      setSearchChildren(new Map());
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const perProject = await Promise.all(
          projects.map((p) => getRpcClient().query("fs.search", { dirPath: p.path, query }))
        );
        if (cancelled) return;
        const merged = new Map<string, FsEntry[]>();
        for (const record of perProject) {
          for (const [dir, entries] of Object.entries(record)) merged.set(dir, entries);
        }
        setSearchChildren(merged);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to search:", err);
          setSearchChildren(new Map());
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filtering, query, projects]);

  // Flatten the expanded forest into a single ordered list. Projects are the
  // top level of the hierarchy; their directory contents nest beneath them.
  // When filtering, walk all loaded entries (ignoring the expanded set) and
  // keep a node if its name matches or it has a matching descendant.
  const rows = useMemo<TreeRow[]>(() => {
    const result: TreeRow[] = [];

    if (filtering) {
      const matchedRows = (dirPath: string, depth: number, project: ProjectEntry): TreeRow[] => {
        const entries = searchChildren.get(dirPath);
        if (!entries) return [];
        const out: TreeRow[] = [];
        for (const entry of entries) {
          if (entry.isDirectory) {
            const childRows = matchedRows(entry.path, depth + 1, project);
            if (childRows.length > 0 || entry.name.toLowerCase().includes(query)) {
              out.push({ entry, depth, project, isProject: false });
              out.push(...childRows);
            }
          } else if (entry.name.toLowerCase().includes(query)) {
            out.push({ entry, depth, project, isProject: false });
          }
        }
        return out;
      };
      for (const project of projects) {
        const childRows = matchedRows(project.path, 1, project);
        if (childRows.length > 0 || project.name.toLowerCase().includes(query)) {
          result.push({
            entry: { name: project.name, path: project.path, isDirectory: true },
            depth: 0,
            project,
            isProject: true,
          });
          result.push(...childRows);
        }
      }
      return result;
    }

    const walk = (dirPath: string, depth: number, project: ProjectEntry) => {
      const entries = childrenByDir.get(dirPath);
      if (!entries) return;
      for (const entry of entries) {
        result.push({ entry, depth, project, isProject: false });
        if (entry.isDirectory && expanded.has(entry.path)) {
          walk(entry.path, depth + 1, project);
        }
      }
    };
    for (const project of projects) {
      result.push({
        entry: { name: project.name, path: project.path, isDirectory: true },
        depth: 0,
        project,
        isProject: true,
      });
      if (expanded.has(project.path)) walk(project.path, 1, project);
    }
    return result;
  }, [projects, childrenByDir, searchChildren, expanded, filtering, query]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex-1 flex flex-col min-h-0 mb-3">
      <div className="flex items-center justify-between mb-2 px-0.5">
        <span className="text-xs font-semibold text-base-content/60">Projects</span>
        <button className="btn btn-soft btn-neutral btn-xs" onClick={onAddProject}>
          + Add Project
        </button>
      </div>

      {projects.length > 0 && (
        <div className="relative mb-2 px-0.5">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="input input-xs w-full pr-6"
          />
          {searching ? (
            <span className="loading loading-spinner loading-xs absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40" />
          ) : filter ? (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content"
              title="Clear filter"
              onClick={() => setFilter("")}
            >
              ×
            </button>
          ) : null}
        </div>
      )}

      {projects.length === 0 ? (
        <p className="text-base-content/50 text-xs text-center mt-4 px-2">
          No projects yet. Click "+ Add Project" to add a local directory.
        </p>
      ) : filtering && !searching && rows.length === 0 ? (
        <p className="text-base-content/50 text-xs text-center mt-4 px-2">
          No matches.
        </p>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const { entry, depth, project, isProject } = rows[vi.index];
              const isExpanded = entry.isDirectory && (filtering || expanded.has(entry.path));
              const isLoading = loading.has(entry.path);
              const isSelected = selectedNode?.path === entry.path;
              return (
                <div
                  key={entry.path}
                  className="group/row"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <div className={`flex items-center w-full h-full rounded ${isSelected ? "bg-primary/15" : "hover:bg-base-300/60"}`}>
                    <div
                      role="button"
                      className={`flex items-center flex-1 min-w-0 h-full text-left whitespace-nowrap px-1 cursor-pointer ${isProject ? "text-xs font-semibold" : "text-xs"} ${isSelected ? "text-primary" : ""}`}
                      style={{ paddingLeft: `${depth * 12 + 4}px` }}
                      title={entry.path}
                      onClick={() =>
                        entry.isDirectory
                          ? handleSelectNode({ name: entry.name, path: entry.path })
                          : handleOpenFile(entry, project)
                      }
                    >
                      <span
                        className="inline-block w-3 shrink-0 text-base-content/50"
                        onClick={entry.isDirectory ? (e) => { e.stopPropagation(); toggleDir(entry.path); } : undefined}
                      >
                        {entry.isDirectory ? (isExpanded ? "▾" : "▸") : ""}
                      </span>
                      <span className="shrink-0">{entry.isDirectory ? "📁" : "📄"}</span>
                      <span className={`ml-1 truncate ${!isProject && entry.name.startsWith(".") ? "text-base-content/50" : ""}`}>
                        {entry.name}
                      </span>
                      {isLoading && <span className="loading loading-spinner loading-xs ml-1" />}
                    </div>
                    {isProject && (
                      <button
                        className="opacity-0 group-hover/row:opacity-100 px-1.5 shrink-0 text-base-content/50 hover:text-error"
                        title="Remove project"
                        onClick={(e) => { e.stopPropagation(); onRemoveProject(project); }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsTab;
