import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ProjectEntry, FsEntry, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";

interface ProjectsTabProps {
  projects: ProjectEntry[];
  selectedProject: ProjectEntry | null;
  onSelectProject: (project: ProjectEntry) => void;
  onOpenFile: (file: OpenFile) => void;
  onAddProject: () => void;
  onRemoveProject: (project: ProjectEntry) => void;
}

interface TreeRow {
  entry: FsEntry;
  depth: number;
}

const ROW_HEIGHT = 24;

const ProjectsTab: React.FC<ProjectsTabProps> = ({
  projects,
  selectedProject,
  onSelectProject,
  onOpenFile,
  onAddProject,
  onRemoveProject,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = useState<Map<string, FsEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

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

  // Reset and load root when the selected project changes
  useEffect(() => {
    setExpanded(new Set());
    setChildrenByDir(new Map());
    setLoading(new Set());
    if (selectedProject) {
      loadDir(selectedProject.path);
    }
  }, [selectedProject, loadDir]);

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

  // Flatten the expanded tree into a single ordered list of visible rows.
  const rows = useMemo<TreeRow[]>(() => {
    if (!selectedProject) return [];
    const result: TreeRow[] = [];
    const walk = (dirPath: string, depth: number) => {
      const entries = childrenByDir.get(dirPath);
      if (!entries) return;
      for (const entry of entries) {
        result.push({ entry, depth });
        if (entry.isDirectory && expanded.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    };
    walk(selectedProject.path, 0);
    return result;
  }, [selectedProject, childrenByDir, expanded]);

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
        <ul className="menu menu-sm p-0 gap-0.5 mb-2">
          {projects.map((project) => (
            <li key={project.path}>
              <div
                className={`flex items-center justify-between group rounded ${selectedProject?.path === project.path ? "bg-primary/15 text-primary" : ""}`}
              >
                <button
                  className="flex-1 text-left truncate px-2 py-1"
                  title={project.path}
                  onClick={() => onSelectProject(project)}
                >
                  📁 {project.name}
                </button>
                <button
                  className="opacity-0 group-hover:opacity-100 px-1.5 text-base-content/50 hover:text-error"
                  title="Remove project"
                  onClick={() => onRemoveProject(project)}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selectedProject && (
        <div ref={parentRef} className="flex-1 overflow-auto border-t border-base-300 pt-1">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const { entry, depth } = rows[vi.index];
              const isExpanded = entry.isDirectory && expanded.has(entry.path);
              const isLoading = loading.has(entry.path);
              return (
                <div
                  key={entry.path}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${ROW_HEIGHT}px`,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <button
                    className="flex items-center w-full h-full text-left text-xs hover:bg-base-300/60 rounded px-1 whitespace-nowrap"
                    style={{ paddingLeft: `${depth * 12 + 4}px` }}
                    title={entry.name}
                    onClick={() =>
                      entry.isDirectory
                        ? toggleDir(entry.path)
                        : onOpenFile({ path: entry.path, name: entry.name })
                    }
                  >
                    <span className="inline-block w-3 shrink-0 text-base-content/50">
                      {entry.isDirectory ? (isExpanded ? "▾" : "▸") : ""}
                    </span>
                    <span className="shrink-0">{entry.isDirectory ? "📁" : "📄"}</span>
                    <span className={`ml-1 truncate ${entry.name.startsWith(".") ? "text-base-content/50" : ""}`}>
                      {entry.name}
                    </span>
                    {isLoading && <span className="loading loading-spinner loading-xs ml-1" />}
                  </button>
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
