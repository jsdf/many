import React, { useMemo, useState, useCallback, useRef } from "react";
import { ProjectEntry, ProjectNode } from "../types";
import { getRpcClient } from "../rpc-client";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import FsActionDialog, { FsAction } from "./FsActionDialog";
import { FileTreeRow } from "./FileTree";
import { useFsTree } from "../useFsTree";
import { useOpenFile } from "../useFileEditors";
import { arrayMove } from "@dnd-kit/sortable";
import { WorktreeActivity, isActive, sumActivityUnder } from "../treeActivity";
import { PinToggle, pinMenuItem } from "./pinControls";
import { relativeToRoot } from "../paths";
import ActivePane from "./ActivePane";
import ProjectsPane from "./ProjectsPane";
import { Ban, X } from "lucide-react";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((err) => console.error("Failed to copy:", err));
}

interface ProjectsTabProps {
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onSelectNode: (node: ProjectNode) => void;
  onAddProject: () => void;
  onRemoveProject: (project: ProjectEntry) => void;
  onCloseProject: (path: string, name: string) => void;
  onResumeRecentSession: (worktreePath: string, sessionId: string, sessionType?: "chat" | "claude-code") => void;
  worktreeActivity?: Record<string, WorktreeActivity>;
  pinnedFolders: string[];
  onTogglePin: (path: string, pinned: boolean) => void;
  onReorderPin: (order: string[]) => void;
  pinnedSessions: string[];
  onTogglePinnedSession: (key: string, pinned: boolean) => void;
}

// Thin shell composing the Active pane and Projects pane. Owns the fs-tree
// state and the row-interaction behavior (click/caret/context-menu/right-slot)
// shared by both trees, plus the Projects-collapsed flag that the Active pane
// needs to know whether it should maximise.
const ProjectsTab: React.FC<ProjectsTabProps> = ({
  projects,
  selectedNode,
  onSelectNode,
  onAddProject,
  onRemoveProject,
  onCloseProject,
  onResumeRecentSession,
  worktreeActivity,
  pinnedFolders,
  onTogglePin,
  onReorderPin,
  pinnedSessions,
  onTogglePinnedSession,
}) => {
  const { expanded, childrenByDir, loading, toggleDir, expandDir, expandPath } = useFsTree();
  const openFile = useOpenFile();
  const [filter, setFilter] = useState("");
  const filtering = filter.trim().length > 0;
  // Right-click context menu + the create/rename/delete dialog it opens.
  const [menu, setMenu] = useState<{ x: number; y: number; row: FileTreeRow } | null>(null);
  const [fsAction, setFsAction] = useState<FsAction | null>(null);

  const pinned = useMemo(() => new Set(pinnedFolders), [pinnedFolders]);

  // Accordion collapse of the Active / Projects sections via their headers.
  // Active's own collapse state lives in ActivePane; Projects' lives here
  // because the Active pane needs it to know whether to maximise.
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => localStorage.getItem("projectsProjectsCollapsed") === "true",
  );
  const toggleProjectsCollapsed = useCallback(() => {
    setProjectsCollapsed((c) => {
      localStorage.setItem("projectsProjectsCollapsed", String(!c));
      return !c;
    });
  }, []);

  // While the Active pane's resize divider is being dragged, text selection is
  // disabled across the whole container (not just the Active pane) since the
  // drag is tracked via window-level mouse listeners.
  const [draggingActive, setDraggingActive] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Toggle a directory's expansion. Collapsing just drops the dir. Expanding
  // records the full ancestor chain only while filtering (so the dir stays
  // reachable once the filter clears); otherwise a single dir, since ancestors
  // are already open. Chaining up to the project root would wrongly expand a
  // containing pinned folder that hosts this one as a nested Active-tree root.
  const toggleNode = useCallback(
    (dirPath: string, projectPath: string) => {
      if (expanded.has(dirPath)) toggleDir(dirPath);
      else if (filtering) expandPath(dirPath, projectPath);
      else expandDir(dirPath);
    },
    [expanded, toggleDir, expandDir, expandPath, filtering],
  );

  // Clicking a directory title selects it first. Only a subsequent click on the
  // already-selected folder toggles its expansion, so selecting a folder doesn't
  // also collapse/expand it in the same click.
  const handleClickNode = useCallback(
    (node: ProjectNode, projectPath: string) => {
      if (selectedNode?.path === node.path) {
        toggleNode(node.path, projectPath);
      } else {
        onSelectNode(node);
      }
    },
    [onSelectNode, toggleNode, selectedNode?.path],
  );

  // Opening a file first switches the panel to its containing directory, then
  // opens the file there.
  const handleOpenFile = useCallback(
    (entry: { path: string; name: string; isDirectory: boolean }, project: ProjectEntry) => {
      const sep = entry.path.includes("\\") ? "\\" : "/";
      const i = entry.path.lastIndexOf(sep);
      const parentPath = i >= 0 ? entry.path.slice(0, i) : project.path;
      const node: ProjectNode =
        parentPath === project.path
          ? { name: project.name, path: project.path }
          : { name: parentPath.slice(parentPath.lastIndexOf(sep) + 1), path: parentPath };
      onSelectNode(node);
      expandPath(parentPath, project.path);
      openFile(node.path, { path: entry.path, name: entry.name });
    },
    [onSelectNode, openFile, expandPath],
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
      items.push({
        label: "Open in Editor",
        onClick: () =>
          getRpcClient()
            .query("action.openEditor", { path: entry.path })
            .catch((err) => console.error("[action] openEditor failed:", err)),
      });
      if (!entry.isDirectory) {
        items.push({
          label: "Open in default app",
          onClick: () =>
            getRpcClient()
              .query("action.openPath", { path: entry.path })
              .catch((err) => console.error("[action] openPath failed:", err)),
        });
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
      toggleNode(row.entry.path, project.path);
    },
    [toggleNode],
  );

  const handleReorderPin = useCallback(
    (activeId: string, overId: string) => {
      const oldIndex = pinnedFolders.indexOf(activeId);
      const newIndex = pinnedFolders.indexOf(overId);
      if (oldIndex < 0 || newIndex < 0) return;
      onReorderPin(arrayMove(pinnedFolders, oldIndex, newIndex));
    },
    [pinnedFolders, onReorderPin],
  );

  const handleContextMenu = useCallback((row: FileTreeRow, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, row });
  }, []);

  const renderRightSlot = useCallback(
    (row: FileTreeRow) => {
      if (!row.entry.isDirectory) return undefined;
      // Close is offered whenever this folder has rolled-up activity (its own or
      // any descendant's), so it clears everything the badge counts. The close
      // handler fans out over every descendant path with terminals.
      const rolled = sumActivityUnder(worktreeActivity, row.entry.path);
      const closeButton =
        isActive(rolled) ? (
          <button
            className="opacity-0 group-hover/row:opacity-100 px-1 shrink-0 text-base-content/50 hover:text-error"
            title="Close all terminals under this folder"
            onClick={(e) => {
              e.stopPropagation();
              onCloseProject(row.entry.path, row.entry.name);
            }}
          >
            <Ban size={12} />
          </button>
        ) : null;
      return (
        <>
          {closeButton}
          {row.isProject ? (
            <button
              className="opacity-0 group-hover/row:opacity-100 px-1.5 shrink-0 text-base-content/50 hover:text-error"
              title="Remove project"
              onClick={(e) => {
                e.stopPropagation();
                if (row.project) onRemoveProject(row.project);
              }}
            >
              <X size={12} />
            </button>
          ) : (
            <PinToggle
              pinned={pinned.has(row.entry.path)}
              onToggle={() => onTogglePin(row.entry.path, !pinned.has(row.entry.path))}
            />
          )}
        </>
      );
    },
    [pinned, onTogglePin, onRemoveProject, onCloseProject, worktreeActivity],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-h-0 mb-3"
      style={{ userSelect: draggingActive ? "none" : undefined }}
    >
      <ActivePane
        projects={projects}
        selectedNode={selectedNode}
        onSelectNode={onSelectNode}
        onResumeRecentSession={onResumeRecentSession}
        worktreeActivity={worktreeActivity}
        pinnedFolders={pinnedFolders}
        pinnedSessions={pinnedSessions}
        onTogglePinnedSession={onTogglePinnedSession}
        projectsCollapsed={projectsCollapsed}
        expanded={expanded}
        childrenByDir={childrenByDir}
        loading={loading}
        handleRowClick={handleRowClick}
        handleToggleCaret={handleToggleCaret}
        handleContextMenu={handleContextMenu}
        renderRightSlot={renderRightSlot}
        handleReorderPin={handleReorderPin}
        containerRef={containerRef}
        onDraggingChange={setDraggingActive}
      />

      <ProjectsPane
        projects={projects}
        selectedNode={selectedNode}
        onAddProject={onAddProject}
        worktreeActivity={worktreeActivity}
        expanded={expanded}
        childrenByDir={childrenByDir}
        loading={loading}
        filter={filter}
        onFilterChange={setFilter}
        projectsCollapsed={projectsCollapsed}
        onToggleProjectsCollapsed={toggleProjectsCollapsed}
        handleRowClick={handleRowClick}
        handleToggleCaret={handleToggleCaret}
        handleContextMenu={handleContextMenu}
        renderRightSlot={renderRightSlot}
      />

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
