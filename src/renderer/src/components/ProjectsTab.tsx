import React, { useMemo, useRef, useState, useCallback } from "react";
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
  project: ProjectEntry;
  isProject: boolean;
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

  // Selecting a project also drives the main pane (terminals + open files).
  const handleProjectClick = useCallback((project: ProjectEntry) => {
    onSelectProject(project);
    toggleDir(project.path);
  }, [onSelectProject, toggleDir]);

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
              const isSelectedProject = isProject && selectedProject?.path === project.path;
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
                  <div className={`flex items-center w-full h-full rounded ${isSelectedProject ? "bg-primary/15" : "hover:bg-base-300/60"}`}>
                    <button
                      className={`flex items-center flex-1 min-w-0 h-full text-left whitespace-nowrap px-1 ${isProject ? "text-xs font-semibold" : "text-xs"} ${isSelectedProject ? "text-primary" : ""}`}
                      style={{ paddingLeft: `${depth * 12 + 4}px` }}
                      title={entry.path}
                      onClick={() =>
                        isProject
                          ? handleProjectClick(project)
                          : entry.isDirectory
                            ? toggleDir(entry.path)
                            : (onSelectProject(project), onOpenFile({ path: entry.path, name: entry.name }))
                      }
                    >
                      <span className="inline-block w-3 shrink-0 text-base-content/50">
                        {entry.isDirectory ? (isExpanded ? "▾" : "▸") : ""}
                      </span>
                      <span className="shrink-0">{entry.isDirectory ? "📁" : "📄"}</span>
                      <span className={`ml-1 truncate ${!isProject && entry.name.startsWith(".") ? "text-base-content/50" : ""}`}>
                        {entry.name}
                      </span>
                      {isLoading && <span className="loading loading-spinner loading-xs ml-1" />}
                    </button>
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
