import React, { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
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
  // Paths that can be drag-reordered. When set (and non-virtualized), those rows
  // get a drag handle and the list is wrapped in a sortable context.
  sortableIds?: string[];
  onReorder?: (activeId: string, overId: string) => void;
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
  sortableIds,
  onReorder,
}) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortable = React.useMemo(() => new Set(sortableIds ?? []), [sortableIds]);
  const dndEnabled = !virtualized && !!sortableIds && sortableIds.length > 0;
  const parentRef = useRef<HTMLDivElement>(null);

  // Keyboard-navigation cursor, decoupled from selection so arrowing up/down a
  // file tree doesn't select/open every row it passes. Starts on (and re-syncs
  // to) the selected row.
  const [focusedPath, setFocusedPath] = React.useState<string | undefined>(selectedPath);
  useEffect(() => {
    if (selectedPath) setFocusedPath(selectedPath);
  }, [selectedPath]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Bring the selected/focused row into view only when the target itself
  // changes. We intentionally do NOT re-run when `rows` changes: the row list
  // gets a fresh reference on every activity poll, and scrolling on those would
  // yank a manually scrolled-away selection back into view.
  const scrollTarget = focusedPath ?? selectedPath;
  const lastScrolledTarget = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!scrollTarget || scrollTarget === lastScrolledTarget.current) return;
    lastScrolledTarget.current = scrollTarget;
    const index = rows.findIndex((r) => r.entry.path === scrollTarget);
    if (index < 0) return;
    if (virtualized) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    } else {
      parentRef.current
        ?.querySelector(`[data-tree-path="${CSS.escape(scrollTarget)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget, virtualized]);

  // Arrow-key navigation: up/down move the cursor, left/right collapse/expand
  // the focused directory (or hop to parent / first child), Enter activates it.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
    e.preventDefault();
    const idx = rows.findIndex((r) => r.entry.path === focusedPath);
    if (idx < 0) {
      setFocusedPath(rows[0].entry.path);
      return;
    }
    const row = rows[idx];
    const isDir = row.entry.isDirectory;
    const rowExpanded = isDir && isExpanded(row);
    const move = (i: number) => setFocusedPath(rows[i].entry.path);
    const toggle = () => onToggleCaret?.(row, { stopPropagation() {} } as React.MouseEvent);
    switch (e.key) {
      case "ArrowDown":
        if (idx < rows.length - 1) move(idx + 1);
        break;
      case "ArrowUp":
        if (idx > 0) move(idx - 1);
        break;
      case "ArrowRight":
        if (isDir && !rowExpanded) toggle();
        else if (isDir && rowExpanded && idx < rows.length - 1) move(idx + 1);
        break;
      case "ArrowLeft":
        if (isDir && rowExpanded) toggle();
        else {
          for (let j = idx - 1; j >= 0; j--) {
            if (rows[j].depth < row.depth) {
              move(j);
              break;
            }
          }
        }
        break;
      case "Enter":
        onRowClick(row);
        break;
    }
  };

  const renderRow = (
    row: FileTreeRow,
    style: React.CSSProperties,
    drag?: {
      setNodeRef?: (el: HTMLElement | null) => void;
      style?: React.CSSProperties;
      handle: React.ReactNode;
    },
  ) => {
    const { entry, depth, isProject } = row;
    return (
      <div
        key={entry.path}
        ref={drag?.setNodeRef}
        data-tree-path={entry.path}
        className="group/row"
        onContextMenu={onContextMenu ? (e) => onContextMenu(row, e) : undefined}
        style={{ ...style, ...drag?.style }}
      >
        <TreeRowItem
          dragHandle={drag?.handle}
          name={entry.name}
          isDirectory={entry.isDirectory}
          isProject={isProject}
          depth={depth}
          selected={selectedPath === entry.path}
          focused={focusedPath === entry.path}
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
          onClick={() => {
            setFocusedPath(entry.path);
            onRowClick(row);
          }}
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
    // In dnd mode every row reserves a fixed-width left gutter so the grip
    // handle on sortable rows never overlaps the disclosure caret, and sortable
    // and non-sortable rows stay aligned.
    const body = rows.map((row) =>
      dndEnabled && sortable.has(row.entry.path) ? (
        <SortableTreeRow key={row.entry.path} row={row}>
          {(drag) => renderRow(row, { height: ROW_HEIGHT }, drag)}
        </SortableTreeRow>
      ) : dndEnabled ? (
        renderRow(row, { height: ROW_HEIGHT }, { handle: <span className="w-4 shrink-0" /> })
      ) : (
        renderRow(row, { height: ROW_HEIGHT })
      ),
    );
    if (!dndEnabled) {
      return (
        <div ref={parentRef} className={`${scrollClassName} outline-none`} tabIndex={0} onKeyDown={handleKeyDown}>
          {body}
        </div>
      );
    }
    const handleDragEnd = (e: DragEndEvent) => {
      const { active, over } = e;
      if (over && active.id !== over.id) onReorder?.(active.id as string, over.id as string);
    };
    return (
      <div ref={parentRef} className={`${scrollClassName} outline-none`} tabIndex={0} onKeyDown={handleKeyDown}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sortableIds!} strategy={verticalListSortingStrategy}>
            {body}
          </SortableContext>
        </DndContext>
      </div>
    );
  }

  return (
    <div ref={parentRef} className={`${scrollClassName} outline-none`} tabIndex={0} onKeyDown={handleKeyDown}>
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

// Wraps a single reorderable row, wiring dnd-kit's sortable node ref/transform
// to the row container and exposing a grip handle that carries the drag
// listeners (so clicking the row still selects/expands as usual).
const SortableTreeRow: React.FC<{
  row: FileTreeRow;
  children: (drag: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    handle: React.ReactNode;
  }) => React.ReactNode;
}> = ({ row, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.entry.path,
  });
  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
  };
  const handle = (
    <span
      className="w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-base-content/30 hover:text-base-content/70 opacity-0 group-hover/row:opacity-100"
      title="Drag to reorder"
      onClick={(e) => e.stopPropagation()}
      {...attributes}
      {...listeners}
    >
      <GripVertical size={12} />
    </span>
  );
  return <>{children({ setNodeRef, style, handle })}</>;
};

export default FileTree;
