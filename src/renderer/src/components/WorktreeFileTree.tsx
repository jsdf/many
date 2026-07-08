import React, { useEffect, useMemo, useState, useCallback } from "react";
import { ProjectEntry } from "../types";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import FsActionDialog, { FsAction } from "./FsActionDialog";
import FileTree, { FileTreeRow } from "./FileTree";
import { getRpcClient } from "../rpc-client";
import { useFsTree } from "../useFsTree";
import { useOpenFile } from "../useFileEditors";
import { buildTreeRows } from "../treeRows";
import { relativeToRoot } from "../paths";
import { WorktreeActivity } from "../treeActivity";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((err) => console.error("Failed to copy:", err));
}

interface WorktreeFileTreeProps {
  worktreePath: string;
  worktreeName: string;
  worktreeActivity?: Record<string, WorktreeActivity>;
}

// File tree for the currently selected worktree, shown as a section below the
// worktree list. Mirrors the Projects tree (ProjectsTab) but is rooted at the
// single worktree directory; clicking a file opens it in the worktree's editor.
const WorktreeFileTree: React.FC<WorktreeFileTreeProps> = ({
  worktreePath,
  worktreeName,
  worktreeActivity,
}) => {
  const { expanded, childrenByDir, loading, expandDir, handleToggleDir } = useFsTree();
  const openFile = useOpenFile();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: FileTreeRow } | null>(null);
  const [fsAction, setFsAction] = useState<FsAction | null>(null);

  // The worktree root presented as a synthetic project so the shared tree code
  // (buildTreeRows, context-menu relative paths) works unchanged.
  const project = useMemo<ProjectEntry>(
    () => ({ path: worktreePath, name: worktreeName, addedAt: "" }),
    [worktreePath, worktreeName],
  );

  // Reveal the worktree root's contents on selection.
  useEffect(() => {
    expandDir(worktreePath);
  }, [worktreePath, expandDir]);

  const rootRows = useMemo<FileTreeRow[]>(
    () => [
      {
        entry: { name: worktreeName, path: worktreePath, isDirectory: true },
        depth: 0,
        project,
        isProject: true,
      },
    ],
    [worktreeName, worktreePath, project],
  );

  const rows = useMemo<FileTreeRow[]>(
    () => buildTreeRows(rootRows, expanded, childrenByDir),
    [rootRows, expanded, childrenByDir],
  );

  const handleRowClick = useCallback(
    (row: FileTreeRow) => {
      setSelectedPath(row.entry.path);
      if (row.entry.isDirectory) {
        handleToggleDir(row.entry.path, worktreePath);
      } else {
        openFile(worktreePath, { path: row.entry.path, name: row.entry.name });
      }
    },
    [handleToggleDir, openFile, worktreePath],
  );

  const handleToggleCaret = useCallback(
    (row: FileTreeRow, e: React.MouseEvent) => {
      e.stopPropagation();
      handleToggleDir(row.entry.path, worktreePath);
    },
    [handleToggleDir, worktreePath],
  );

  const handleContextMenu = useCallback((row: FileTreeRow, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, row });
  }, []);

  const menuItems = useCallback(
    (row: FileTreeRow): ContextMenuItem[] => {
      const { entry, isProject } = row;
      const items: ContextMenuItem[] = [];
      if (entry.isDirectory) {
        items.push({ label: "New File", onClick: () => setFsAction({ mode: "newFile", dirPath: entry.path }) });
        items.push({ label: "New Folder", onClick: () => setFsAction({ mode: "newFolder", dirPath: entry.path }) });
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
      items.push({ label: "Copy relative path", onClick: () => copyToClipboard(relativeToRoot(entry.path, worktreePath)) });
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
    [worktreePath],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 mb-1">
      <div className="px-1 mb-1 text-[10px] font-semibold text-base-content/50 uppercase tracking-wide">
        Files
      </div>
      <FileTree
        rows={rows}
        selectedPath={selectedPath ?? undefined}
        worktreeActivity={worktreeActivity}
        isExpanded={(row) => expanded.has(row.entry.path)}
        isLoading={(row) => loading.has(row.entry.path)}
        onRowClick={handleRowClick}
        onToggleCaret={handleToggleCaret}
        onContextMenu={handleContextMenu}
        virtualized
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

export default WorktreeFileTree;
