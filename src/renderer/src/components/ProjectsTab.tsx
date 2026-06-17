import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ProjectEntry, ProjectNode, FsEntry, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import FsActionDialog, { FsAction } from "./FsActionDialog";
import FileTree, { FileTreeRow } from "./FileTree";
import { useFsTree } from "../useFsTree";
import { activeRoots, buildTreeRows, sortEntries } from "../treeRows";
import { PinToggle, pinMenuItem } from "./pinControls";
import { relativeToRoot } from "../paths";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((err) => console.error("Failed to copy:", err));
}

interface ProjectsTabProps {
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onSelectNode: (node: ProjectNode) => void;
  onOpenFile: (file: OpenFile) => void;
  onAddProject: () => void;
  onRemoveProject: (project: ProjectEntry) => void;
  worktreeActivity?: Record<string, { terminals: number; claudeSessions: number }>;
  pinnedFolders: string[];
  onTogglePin: (path: string, pinned: boolean) => void;
}

const ProjectsTab: React.FC<ProjectsTabProps> = ({
  projects,
  selectedNode,
  onSelectNode,
  onOpenFile,
  onAddProject,
  onRemoveProject,
  worktreeActivity,
  pinnedFolders,
  onTogglePin,
}) => {
  const { expanded, childrenByDir, loading, expandDir, expandPath, handleToggleDir } = useFsTree();
  const [filter, setFilter] = useState("");
  // Server-side search results, keyed by parent dir, used while filtering.
  const [searchChildren, setSearchChildren] = useState<Map<string, FsEntry[]>>(new Map());
  const [searching, setSearching] = useState(false);
  // Right-click context menu + the create/rename/delete dialog it opens.
  const [menu, setMenu] = useState<{ x: number; y: number; row: FileTreeRow } | null>(null);
  const [fsAction, setFsAction] = useState<FsAction | null>(null);

  const pinned = useMemo(() => new Set(pinnedFolders), [pinnedFolders]);

  // Active pane height. null means "size to content" (capped); once the user
  // drags the divider it becomes an explicit pixel height.
  const [activeHeight, setActiveHeight] = useState<number | null>(null);
  const [draggingActive, setDraggingActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeTreeRef = useRef<HTMLDivElement>(null);

  const handleActiveResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingActive(true);
  }, []);

  useEffect(() => {
    if (!draggingActive) return;
    const MIN_ACTIVE = 60;
    const RESERVE_PROJECTS = 120;
    const handleMove = (e: MouseEvent) => {
      const tree = activeTreeRef.current;
      const container = containerRef.current;
      if (!tree || !container) return;
      const top = tree.getBoundingClientRect().top;
      const maxH = container.getBoundingClientRect().bottom - top - RESERVE_PROJECTS;
      setActiveHeight(Math.max(MIN_ACTIVE, Math.min(Math.max(MIN_ACTIVE, maxH), e.clientY - top)));
    };
    const handleUp = () => setDraggingActive(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [draggingActive]);

  // Root rows for each tree. The Projects tree is rooted at the projects; the
  // Active tree is rooted at active + pinned folders. Both expand identically.
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

  // Clicking a directory title selects it and toggles its expansion, so the
  // title behaves like the caret.
  const handleClickNode = useCallback(
    (node: ProjectNode, projectPath: string) => {
      onSelectNode(node);
      handleToggleDir(node.path, projectPath);
    },
    [onSelectNode, handleToggleDir],
  );

  // Opening a file first switches the panel to its containing directory, then
  // opens the file there.
  const handleOpenFile = useCallback(
    (entry: FsEntry, project: ProjectEntry) => {
      const sep = entry.path.includes("\\") ? "\\" : "/";
      const i = entry.path.lastIndexOf(sep);
      const parentPath = i >= 0 ? entry.path.slice(0, i) : project.path;
      const node: ProjectNode =
        parentPath === project.path
          ? { name: project.name, path: project.path }
          : { name: parentPath.slice(parentPath.lastIndexOf(sep) + 1), path: parentPath };
      onSelectNode(node);
      expandPath(parentPath, project.path);
      onOpenFile({ path: entry.path, name: entry.name });
    },
    [onSelectNode, onOpenFile, expandPath],
  );

  // Build context menu items for a row. Directories can spawn children and be
  // pinned; non-root entries can be renamed or deleted. Project roots are
  // managed via the dedicated "× Remove project" control.
  const menuItems = useCallback(
    (row: FileTreeRow): ContextMenuItem[] => {
      const { entry, isProject, project } = row;
      const items: ContextMenuItem[] = [];
      if (entry.isDirectory) {
        items.push({ label: "New File", onClick: () => setFsAction({ mode: "newFile", dirPath: entry.path }) });
        items.push({ label: "New Folder", onClick: () => setFsAction({ mode: "newFolder", dirPath: entry.path }) });
        items.push(
          pinMenuItem(pinned.has(entry.path), () => onTogglePin(entry.path, !pinned.has(entry.path))),
        );
      }
      if (project) {
        items.push({ label: "Copy relative path", onClick: () => copyToClipboard(relativeToRoot(entry.path, project.path)) });
      }
      items.push({ label: "Copy absolute path", onClick: () => copyToClipboard(entry.path) });
      if (!isProject) {
        items.push({
          label: "Rename",
          onClick: () => setFsAction({ mode: "rename", targetPath: entry.path, currentName: entry.name, isDirectory: entry.isDirectory }),
        });
        items.push({
          label: "Delete",
          danger: true,
          onClick: () => setFsAction({ mode: "delete", targetPath: entry.path, name: entry.name, isDirectory: entry.isDirectory }),
        });
      }
      return items;
    },
    [pinned, onTogglePin],
  );

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
        if (selPath && dirPath === selPath) {
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
        const immediateOfSel = !!selPath && dirPath === selPath;
        for (const entry of childrenFor(dirPath)) {
          if (entry.isDirectory) {
            const childRows = matchedRows(entry.path, depth + 1, project);
            const onSelChain = !!selPath && isAncestorOf(entry.path, selPath);
            if (childRows.length > 0 || entry.name.toLowerCase().includes(query) || onSelChain || immediateOfSel) {
              out.push({ entry, depth, project, isProject: false });
              out.push(...childRows);
            }
          } else if (entry.name.toLowerCase().includes(query) || immediateOfSel) {
            out.push({ entry, depth, project, isProject: false });
          }
        }
        return out;
      };

      for (const project of projects) {
        const childRows = matchedRows(project.path, 1, project);
        const onSelChain = !!selPath && isAncestorOf(project.path, selPath);
        if (childRows.length > 0 || project.name.toLowerCase().includes(query) || onSelChain) {
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
  }, [projectRoots, projects, childrenByDir, searchChildren, expanded, filtering, query, selectedNode?.path]);

  // The Active tree is just the project tree rooted at active + pinned folders,
  // expanded with the same shared state, so it behaves identically.
  const activeRows = useMemo<FileTreeRow[]>(
    () =>
      worktreeActivity
        ? buildTreeRows(activeRoots(projects, worktreeActivity, pinnedFolders), expanded, childrenByDir)
        : [],
    [projects, worktreeActivity, pinnedFolders, expanded, childrenByDir],
  );

  // Click, caret, context-menu and right-slot behavior shared by both trees.
  const handleRowClick = useCallback(
    (row: FileTreeRow) => {
      const project = row.project;
      if (!project) return;
      if (row.entry.isDirectory) {
        handleClickNode({ name: row.entry.name, path: row.entry.path }, project.path);
      } else {
        handleOpenFile(row.entry, project);
      }
    },
    [handleClickNode, handleOpenFile],
  );

  const handleToggleCaret = useCallback(
    (row: FileTreeRow, e: React.MouseEvent) => {
      const project = row.project;
      if (!project) return;
      e.stopPropagation();
      handleToggleDir(row.entry.path, project.path);
    },
    [handleToggleDir],
  );

  const handleContextMenu = useCallback((row: FileTreeRow, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, row });
  }, []);

  const renderRightSlot = useCallback(
    (row: FileTreeRow) =>
      row.isProject ? (
        <button
          className="opacity-0 group-hover/row:opacity-100 px-1.5 shrink-0 text-base-content/50 hover:text-error"
          title="Remove project"
          onClick={(e) => {
            e.stopPropagation();
            if (row.project) onRemoveProject(row.project);
          }}
        >
          ×
        </button>
      ) : row.entry.isDirectory ? (
        <PinToggle
          pinned={pinned.has(row.entry.path)}
          onToggle={() => onTogglePin(row.entry.path, !pinned.has(row.entry.path))}
        />
      ) : undefined,
    [pinned, onTogglePin, onRemoveProject],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-h-0 mb-3"
      style={{ userSelect: draggingActive ? "none" : undefined }}
    >
      {activeRows.length > 0 && (
        <div className="shrink-0 flex flex-col">
          <div className="mb-1 px-0.5">
            <span className="text-xs font-semibold text-base-content/60">Active</span>
          </div>
          <div
            ref={activeTreeRef}
            className="overflow-hidden"
            style={activeHeight === null ? undefined : { height: activeHeight }}
          >
            <FileTree
              rows={activeRows}
              selectedPath={selectedNode?.path}
              worktreeActivity={worktreeActivity}
              isExpanded={(row) => expanded.has(row.entry.path)}
              isLoading={(row) => loading.has(row.entry.path)}
              onRowClick={handleRowClick}
              onToggleCaret={handleToggleCaret}
              onContextMenu={handleContextMenu}
              rightSlot={renderRightSlot}
              scrollClassName={activeHeight === null ? "max-h-48 overflow-auto" : "h-full overflow-auto"}
            />
          </div>
          <div
            className={`shrink-0 h-1 my-1.5 rounded cursor-ns-resize transition-colors ${draggingActive ? "bg-primary" : "bg-base-300 hover:bg-primary"}`}
            onMouseDown={handleActiveResizeStart}
            title="Drag to resize"
          />
        </div>
      )}

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
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}

      {fsAction && (
        <FsActionDialog
          action={fsAction}
          onClose={() => setFsAction(null)}
          onReveal={expandDir}
        />
      )}
    </div>
  );
};

export default ProjectsTab;
