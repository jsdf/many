import React, { useEffect, useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import { ProjectEntry, ProjectNode, FsEntry } from "../types";
import { getRpcClient } from "../rpc-client";
import FileTree, { FileTreeRow } from "./FileTree";
import { buildTreeRows, sortEntries } from "../treeRows";
import { WorktreeActivity } from "../treeActivity";

interface ProjectsPaneProps {
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onAddProject: () => void;
  worktreeActivity?: Record<string, WorktreeActivity>;
  expanded: Set<string>;
  childrenByDir: Map<string, FsEntry[]>;
  loading: Set<string>;
  filter: string;
  onFilterChange: (filter: string) => void;
  projectsCollapsed: boolean;
  onToggleProjectsCollapsed: () => void;
  // Row click/caret/context-menu/right-slot behavior shared with the Active tree.
  handleRowClick: (row: FileTreeRow) => void;
  handleToggleCaret: (row: FileTreeRow, e: React.MouseEvent) => void;
  handleContextMenu: (row: FileTreeRow, e: React.MouseEvent) => void;
  renderRightSlot: (row: FileTreeRow) => React.ReactNode;
}

// The "Projects" section of the Projects tab: the header (with the add-project
// button and collapse toggle), the filter input with server-side search, and
// the main file tree.
const ProjectsPane: React.FC<ProjectsPaneProps> = ({
  projects,
  selectedNode,
  onAddProject,
  worktreeActivity,
  expanded,
  childrenByDir,
  loading,
  filter,
  onFilterChange,
  projectsCollapsed,
  onToggleProjectsCollapsed,
  handleRowClick,
  handleToggleCaret,
  handleContextMenu,
  renderRightSlot,
}) => {
  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;
  // Server-side search results, keyed by parent dir, used while filtering.
  const [searchChildren, setSearchChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const [searching, setSearching] = useState(false);

  // Root rows for the Projects tree, rooted at the projects.
  const projectRoots = useMemo<FileTreeRow[]>(
    () =>
      projects.map((project) => ({
        entry: { name: project.name, path: project.path, isDirectory: true },
        depth: 0,
        project,
        isProject: true,
      })),
    [projects],
  );

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
  // top level; their directory contents nest beneath them. When filtering, walk
  // the matched subtree and keep a node if its name matches or it has a matching
  // descendant. The currently selected directory's immediate children are
  // always included, regardless of the filter.
  const rows = useMemo<FileTreeRow[]>(() => {
    const result: FileTreeRow[] = [];
    const selPath = selectedNode?.path;

    if (filtering) {
      const sepFor = (p: string) => (p.includes("\\") ? "\\" : "/");
      const isAncestorOf = (anc: string, p: string) => p === anc || p.startsWith(anc + sepFor(p));

      // Structural children for a dir while filtering: matched entries, plus the
      // selected dir's full immediate children, plus a synthesized chain segment
      // so we can descend to the selected dir even when nothing matches.
      const childrenFor = (dirPath: string): FsEntry[] => {
        const map = new Map<string, FsEntry>();
        for (const e of searchChildren.get(dirPath) ?? []) map.set(e.path, e);
        // While search is loading, supplement with cached children to avoid blank flash.
        // Once results arrive, only show filtered results.
        if (searching && selPath && dirPath === selPath) {
          for (const e of childrenByDir.get(dirPath) ?? []) map.set(e.path, e);
        }
        if (selPath && selPath !== dirPath && isAncestorOf(dirPath, selPath)) {
          const sep = sepFor(selPath);
          const nextName = selPath.slice(dirPath.length + sep.length).split(sep)[0];
          const nextPath = dirPath + sep + nextName;
          if (!map.has(nextPath)) map.set(nextPath, { name: nextName, path: nextPath, isDirectory: true });
        }
        return sortEntries([...map.values()]);
      };

      const matchedRows = (dirPath: string, depth: number, project: ProjectEntry): FileTreeRow[] => {
        const out: FileTreeRow[] = [];
        // The server already fuzzy-matched by item name; every returned entry is
        // either a match itself or an ancestor directory of one. We trust the
        // results wholesale: a matched directory legitimately has no children
        // here, so we render every returned dir rather than dropping the
        // childless ones (which would hide directory matches).
        for (const entry of childrenFor(dirPath)) {
          if (entry.isDirectory) {
            out.push({ entry, depth, project, isProject: false });
            out.push(...matchedRows(entry.path, depth + 1, project));
          } else {
            out.push({ entry, depth, project, isProject: false });
          }
        }
        return out;
      };

      for (const project of projects) {
        const childRows = matchedRows(project.path, 1, project);
        const onSelChain = !!selPath && isAncestorOf(project.path, selPath);
        if (childRows.length > 0 || onSelChain) {
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

    return buildTreeRows(projectRoots, expanded, childrenByDir);
  }, [projectRoots, projects, childrenByDir, searchChildren, expanded, filtering, searching, query, selectedNode?.path]);

  return (
    <>
      <div
        className="flex items-center justify-between mb-2 px-0.5 cursor-pointer"
        onClick={onToggleProjectsCollapsed}
      >
        <span className="text-xs font-semibold text-base-content/60 flex items-center gap-0.5">
          {projectsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          Projects
        </span>
        <button
          className="btn btn-outline btn-neutral btn-xs"
          onClick={(e) => {
            e.stopPropagation();
            onAddProject();
          }}
        >
          + Add Project
        </button>
      </div>

      {!projectsCollapsed && projects.length > 0 && (
        <div className="relative mb-2 px-0.5">
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter files..."
            className="input input-xs w-full pr-6"
          />
          {searching ? (
            <span className="loading loading-spinner loading-xs absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40" />
          ) : filter ? (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content"
              title="Clear filter"
              onClick={() => onFilterChange("")}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      )}

      {!projectsCollapsed &&
        (projects.length === 0 ? (
          <p className="text-base-content/50 text-xs text-center mt-4 px-2">
            No projects yet. Click "+ Add Project" to add a local directory.
          </p>
        ) : filtering && !searching && rows.length === 0 ? (
          <p className="text-base-content/50 text-xs text-center mt-4 px-2">
            No matches.
          </p>
        ) : (
          <FileTree
            rows={rows}
            selectedPath={selectedNode?.path}
            worktreeActivity={worktreeActivity}
            isExpanded={(row) => filtering || expanded.has(row.entry.path)}
            isLoading={(row) => loading.has(row.entry.path)}
            onRowClick={handleRowClick}
            onToggleCaret={handleToggleCaret}
            onContextMenu={handleContextMenu}
            rightSlot={renderRightSlot}
            virtualized
          />
        ))}
    </>
  );
};

export default ProjectsPane;
