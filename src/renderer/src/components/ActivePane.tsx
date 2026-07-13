import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ProjectEntry, ProjectNode, FsEntry } from "../types";
import FileTree, { FileTreeRow } from "./FileTree";
import { activeRoots, buildTreeRows } from "../treeRows";
import { WorktreeActivity } from "../treeActivity";
import { PinToggle } from "./pinControls";
import { useFocusedTerminal } from "../focused-terminal";
import { useRecentItems } from "../hooks/useRecentItems";

interface ActivePaneProps {
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  onSelectNode: (node: ProjectNode) => void;
  onResumeRecentSession: (worktreePath: string, sessionId: string, sessionType?: "chat" | "claude-code") => void;
  worktreeActivity?: Record<string, WorktreeActivity>;
  pinnedFolders: string[];
  pinnedSessions: string[];
  onTogglePinnedSession: (key: string, pinned: boolean) => void;
  // Collapsing Projects hands its space to the Active pane so it can be maximised.
  projectsCollapsed: boolean;
  expanded: Set<string>;
  childrenByDir: Map<string, FsEntry[]>;
  loading: Set<string>;
  // Row click/caret/context-menu/right-slot behavior shared with the Projects tree.
  handleRowClick: (row: FileTreeRow) => void;
  handleToggleCaret: (row: FileTreeRow, e: React.MouseEvent) => void;
  handleContextMenu: (row: FileTreeRow, e: React.MouseEvent) => void;
  renderRightSlot: (row: FileTreeRow) => React.ReactNode;
  handleReorderPin: (activeId: string, overId: string) => void;
  // The outer ProjectsTab container, used to bound the resize drag.
  containerRef: React.RefObject<HTMLDivElement | null>;
  onDraggingChange?: (dragging: boolean) => void;
}

// The "Active" section of the Projects tab: a folder tree of active/pinned
// folders, or a flat recency-ordered list of live terminals + recent Claude
// sessions, with its own collapse state and a resizable height.
const ActivePane: React.FC<ActivePaneProps> = ({
  projects,
  selectedNode,
  onSelectNode,
  onResumeRecentSession,
  worktreeActivity,
  pinnedFolders,
  pinnedSessions,
  onTogglePinnedSession,
  projectsCollapsed,
  expanded,
  childrenByDir,
  loading,
  handleRowClick,
  handleToggleCaret,
  handleContextMenu,
  renderRightSlot,
  handleReorderPin,
  containerRef,
  onDraggingChange,
}) => {
  // Active pane mode: the folder tree ("folders"), or a flat list of all live
  // terminals ordered by recency ("sessions").
  const [activeMode, setActiveMode] = useState<"byFolder" | "recent">("byFolder");
  // Tracks the specific recent item that was last clicked (key = "t:<terminalId>" or "c:<sessionId>").
  const [selectedRecentKey, setSelectedRecentKey] = useState<string | null>(null);
  const focusedTerminalId = useFocusedTerminal();
  const recentItems = useRecentItems(projects, activeMode, pinnedSessions);
  const pinnedSessionSet = React.useMemo(() => new Set(pinnedSessions), [pinnedSessions]);

  // Active pane height. null means "size to content" (capped); once the user
  // drags the divider it becomes an explicit pixel height. Persisted to
  // localStorage so it survives navigating away and back to the projects page.
  const [activeHeight, setActiveHeight] = useState<number | null>(() => {
    const s = localStorage.getItem("projectsActiveHeight");
    return s !== null && s !== "" ? Number(s) : null;
  });
  const [draggingActive, setDraggingActive] = useState(false);
  // Accordion collapse of the Active section via its header.
  const [activeCollapsed, setActiveCollapsed] = useState(
    () => localStorage.getItem("projectsActiveCollapsed") === "true",
  );
  // Collapsing Projects hands its space to the Active pane so it can be maximised.
  const maximizeActive = projectsCollapsed && !activeCollapsed;
  const activeTreeRef = useRef<HTMLDivElement>(null);
  const latestHeightRef = useRef<number>(0);

  useEffect(() => {
    onDraggingChange?.(draggingActive);
  }, [draggingActive, onDraggingChange]);

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
      const h = Math.max(MIN_ACTIVE, Math.min(Math.max(MIN_ACTIVE, maxH), e.clientY - top));
      latestHeightRef.current = h;
      setActiveHeight(h);
    };
    const handleUp = () => {
      setDraggingActive(false);
      localStorage.setItem("projectsActiveHeight", String(latestHeightRef.current));
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [draggingActive, containerRef]);

  const baseName = useCallback((p: string) => {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
  }, []);

  // The Active tree is just the project tree rooted at active + pinned folders,
  // expanded with the same shared state, so it behaves identically.
  const activeRows = React.useMemo<FileTreeRow[]>(
    () =>
      worktreeActivity
        ? buildTreeRows(activeRoots(projects, worktreeActivity, pinnedFolders), expanded, childrenByDir)
        : [],
    [projects, worktreeActivity, pinnedFolders, expanded, childrenByDir],
  );

  if (activeRows.length === 0) return null;

  return (
    <div className={`flex flex-col ${maximizeActive ? "flex-1 min-h-0" : "shrink-0"}`}>
      <div
        className="mb-1 px-0.5 flex items-center justify-between gap-2 cursor-pointer"
        onClick={() =>
          setActiveCollapsed((c) => {
            localStorage.setItem("projectsActiveCollapsed", String(!c));
            return !c;
          })
        }
      >
        <span className="text-xs font-semibold text-base-content/60 flex items-center gap-0.5">
          {activeCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          Active
        </span>
        <div className="join" onClick={(e) => e.stopPropagation()}>
          <button
            className={`join-item btn btn-xs ${activeMode === "recent" ? "btn-primary" : "btn-outline btn-neutral"}`}
            onClick={() => setActiveMode("recent")}
          >
            sessions
          </button>
          <button
            className={`join-item btn btn-xs ${activeMode === "byFolder" ? "btn-primary" : "btn-outline btn-neutral"}`}
            onClick={() => setActiveMode("byFolder")}
          >
            folders
          </button>
        </div>
      </div>
      {!activeCollapsed && (
      <div
        ref={activeTreeRef}
        className={`overflow-hidden ${maximizeActive ? "flex-1 min-h-0" : ""}`}
        style={maximizeActive || activeHeight === null ? undefined : { height: activeHeight }}
      >
        {activeMode === "byFolder" ? (
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
            sortableIds={pinnedFolders}
            onReorder={handleReorderPin}
            scrollClassName={maximizeActive || activeHeight !== null ? "h-full overflow-auto" : "max-h-48 overflow-auto"}
          />
        ) : (
          <div className={maximizeActive || activeHeight !== null ? "h-full overflow-auto" : "max-h-48 overflow-auto"}>
            {recentItems.length === 0 ? (
              <p className="text-base-content/50 text-xs px-2 py-1">Nothing recent</p>
            ) : (
              recentItems.map((item) => {
                const itemKey = item.kind === "terminal" ? `t:${item.terminalId}` : `c:${item.sessionId}`;
                const selected = selectedRecentKey === itemKey;
                const focused = item.kind === "terminal" && item.terminalId === focusedTerminalId;
                const onClick =
                  item.kind === "terminal"
                    ? () => { setSelectedRecentKey(itemKey); onSelectNode({ name: baseName(item.worktreePath), path: item.worktreePath }); }
                    : () => { setSelectedRecentKey(itemKey); onResumeRecentSession(item.worktreePath, item.sessionId, item.sessionType); };
                return (
                  <div
                    key={itemKey}
                    className={`group/row flex items-center h-6 px-1.5 rounded cursor-pointer text-xs ${focused ? "bg-base-content text-base-100" : selected ? "bg-primary/15 text-primary" : "hover:bg-base-300/60"}`}
                    title={item.worktreePath}
                    onClick={onClick}
                  >
                    <span className={`shrink-0 text-[10px] mr-1.5 ${focused ? "text-base-100/70" : "text-base-content/40"}`}>
                      {item.kind === "terminal" ? ">_" : "◆"}
                    </span>
                    <span className={`shrink-0 max-w-[45%] truncate mr-1.5 ${focused ? "text-base-100/70" : "text-base-content/50"}`}>
                      {baseName(item.worktreePath)}
                    </span>
                    {item.needsAttention && (
                      <span
                        className={`shrink-0 w-2 h-2 rounded-full mr-1.5 ${focused ? "bg-base-100" : "bg-warning"}`}
                        title="Activity since last interaction"
                      />
                    )}
                    <span className="flex-1 truncate">
                      {item.kind === "terminal" ? (item.title ? `Terminal ${item.terminalNumber}: ${item.title}` : `Terminal ${item.terminalNumber}`) : item.label}
                    </span>
                    <PinToggle
                      pinned={pinnedSessionSet.has(itemKey)}
                      onToggle={() => onTogglePinnedSession(itemKey, !pinnedSessionSet.has(itemKey))}
                    />
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      )}
      {!activeCollapsed && !maximizeActive && (
        <div
          className={`shrink-0 h-1 my-1.5 rounded cursor-ns-resize transition-colors ${draggingActive ? "bg-primary" : "bg-base-300 hover:bg-primary"}`}
          onMouseDown={handleActiveResizeStart}
          title="Drag to resize"
        />
      )}
    </div>
  );
};

export default ActivePane;
