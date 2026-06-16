import React, { useMemo, useRef, useState, useCallback } from "react";
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
  const parentRef = useRef<HTMLDivElement>(null);

  // Mirror persisted state back into the module cache on every update.
  const setExpanded = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setExpandedState((prev) => (treeStateCache.expanded = updater(prev)));
  }, []);
  const setChildrenByDir = useCallback((updater: (prev: Map<string, FsEntry[]>) => Map<string, FsEntry[]>) => {
    setChildrenByDirState((prev) => (treeStateCache.childrenByDir = updater(prev)));
  }, []);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading((prev) => new Set(prev).add(dirPath));
    try {
      const entries = await getRpcClient().query("fs.listDir", { dirPath });
      setChildrenByDir((prev) => new Map(prev).set(dirPath, entries));
    } catch (err) {
      console.error("Failed to list directory:", err);
      setChildrenByDir((prev) => new Map(prev).set(dirPath, []));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        if (!childrenByDir.has(dirPath)) loadDir(dirPath);
      }
      return next;
    });
  }, [childrenByDir, loadDir]);

  // Ensure a directory is expanded (and its children loaded) without toggling
  // it closed. Used when selecting a directory, so selection also reveals it.
  const expandDir = useCallback((dirPath: string) => {
    setExpanded((prev) => (prev.has(dirPath) ? prev : new Set(prev).add(dirPath)));
    if (!childrenByDir.has(dirPath)) loadDir(dirPath);
  }, [childrenByDir, loadDir]);

  // Selecting a node (project root or directory) drives the main pane
  // (terminals + file tabs) and reveals its contents.
  const handleSelectNode = useCallback((node: ProjectNode) => {
    onSelectNode(node);
    expandDir(node.path);
  }, [onSelectNode, expandDir]);

  // Flatten the expanded forest into a single ordered list. Projects are the
  // top level of the hierarchy; their directory contents nest beneath them.
  const rows = useMemo<TreeRow[]>(() => {
    const result: TreeRow[] = [];
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
  }, [projects, childrenByDir, expanded]);

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

      {projects.length === 0 ? (
        <p className="text-base-content/50 text-xs text-center mt-4 px-2">
          No projects yet. Click "+ Add Project" to add a local directory.
        </p>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const { entry, depth, project, isProject } = rows[vi.index];
              const isExpanded = entry.isDirectory && expanded.has(entry.path);
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
                          : (selectedNode || onSelectNode({ name: project.name, path: project.path }), onOpenFile({ path: entry.path, name: entry.name }))
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
