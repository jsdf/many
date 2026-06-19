import React, { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FsEntry, ProjectEntry } from "../types";
import { WorktreeActivity, sumActivityUnder } from "../treeActivity";
import TreeRowItem from "./TreeRowItem";

export interface FileTreeRow {
  entry: FsEntry;
  depth: number;
  isProject: boolean;
  project?: ProjectEntry;
}

const ROW_HEIGHT = 24;

interface FileTreeProps {
  rows: FileTreeRow[];
  selectedPath?: string;
  worktreeActivity?: Record<string, WorktreeActivity>;
  isExpanded: (row: FileTreeRow) => boolean;
  isLoading?: (row: FileTreeRow) => boolean;
  onRowClick: (row: FileTreeRow) => void;
  onToggleCaret?: (row: FileTreeRow, e: React.MouseEvent) => void;
  onContextMenu?: (row: FileTreeRow, e: React.MouseEvent) => void;
  rightSlot?: (row: FileTreeRow) => React.ReactNode;
  scrollClassName?: string;
  virtualized?: boolean;
}

// Shared list renderer for the Projects tree and the Active tree. Both build
// their own flat row list (different roots / filtering) and render it here.
const FileTree: React.FC<FileTreeProps> = ({
  rows,
  selectedPath,
  worktreeActivity,
  isExpanded,
  isLoading,
  onRowClick,
  onToggleCaret,
  onContextMenu,
  rightSlot,
  scrollClassName = "flex-1 overflow-auto",
  virtualized = false,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Keep the selected row visible. Virtualized lists scroll by index (the row
  // may not be in the DOM); plain lists scroll the rendered element. Re-runs
  // when the row list changes too, so selection stays visible after expand.
  useEffect(() => {
    if (!selectedPath) return;
    const index = rows.findIndex((r) => r.entry.path === selectedPath);
    if (index < 0) return;
    if (virtualized) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    } else {
      parentRef.current
        ?.querySelector(`[data-tree-path="${CSS.escape(selectedPath)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, rows, virtualized]);

  const renderRow = (row: FileTreeRow, style: React.CSSProperties) => {
    const { entry, depth, isProject } = row;
    return (
      <div
        key={entry.path}
        data-tree-path={entry.path}
        className="group/row"
        onContextMenu={onContextMenu ? (e) => onContextMenu(row, e) : undefined}
        style={style}
      >
        <TreeRowItem
          name={entry.name}
          isDirectory={entry.isDirectory}
          isProject={isProject}
          depth={depth}
          selected={selectedPath === entry.path}
          expanded={entry.isDirectory && isExpanded(row)}
          loading={isLoading?.(row)}
          dimmed={!isProject && entry.name.startsWith(".")}
          title={entry.path}
          terminalCount={
            entry.isDirectory ? sumActivityUnder(worktreeActivity, entry.path).terminals : 0
          }
          openFileCount={
            entry.isDirectory ? sumActivityUnder(worktreeActivity, entry.path).openFiles : 0
          }
          onClick={() => onRowClick(row)}
          onToggleCaret={
            entry.isDirectory && onToggleCaret
              ? (e) => onToggleCaret(row, e)
              : undefined
          }
          rightSlot={rightSlot?.(row)}
        />
      </div>
    );
  };

  if (!virtualized) {
    return (
      <div ref={parentRef} className={scrollClassName}>
        {rows.map((row) => renderRow(row, { height: ROW_HEIGHT }))}
      </div>
    );
  }

  return (
    <div ref={parentRef} className={scrollClassName}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) =>
          renderRow(rows[vi.index], {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: `${ROW_HEIGHT}px`,
            transform: `translateY(${vi.start}px)`,
          }),
        )}
      </div>
    </div>
  );
};

export default FileTree;
