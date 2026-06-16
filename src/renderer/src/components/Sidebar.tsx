import React, { useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Repository,
  Worktree,
  PoolConfig,
  ProjectEntry,
  ProjectNode,
  OpenFile,
  isTmpBranch,
  formatBranchName,
  findWorktreePool,
} from "../types";
import { useWorktreeActivityTimes } from "../rpc-hooks";
import ProjectsTab from "./ProjectsTab";

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface WorktreeActivity {
  terminals: number;
  claudeSessions: number;
}

export type AutomationsSubView = "running" | "definitions";

interface SidebarProps {
  repositories: Repository[];
  currentRepo: string | null;
  worktrees: Worktree[];
  selectedWorktree: Worktree | null;
  pools?: PoolConfig[];
  worktreeActivity?: Record<string, WorktreeActivity>;
  starredWorktrees: Set<string>;
  worktreeOrder: string[];
  automationsSubView?: AutomationsSubView | null;
  activeTab: "worktrees" | "tracked" | "automations" | "projects";
  projects: ProjectEntry[];
  selectedNode: ProjectNode | null;
  pinnedFolders: string[];
  onTogglePin: (path: string, pinned: boolean) => void;
  onRepoSelect: (repoPath: string | null) => void;
  onWorktreeSelect: (worktree: Worktree | null) => void;
  onCreateWorktree: () => void;
  onConfigRepo: () => void;
  onSwitchWorktree?: () => void;
  onClaimPool?: (pool: PoolConfig) => void;
  onNewTask?: () => void;
  onNavigateWorktrees?: () => void;
  onNavigateTracked?: () => void;
  onNavigateProjects?: () => void;
  onSelectNode?: (node: ProjectNode) => void;
  onOpenFile?: (file: OpenFile) => void;
  onAddProject?: () => void;
  onRemoveProject?: (project: ProjectEntry) => void;
  onAutomationsSubViewChange?: (view: AutomationsSubView) => void;
  onArchiveWorktrees?: (worktrees: Worktree[]) => void;
  onToggleStar: (worktreePath: string) => void;
  onReorderWorktrees: (orderedPaths: string[]) => void;
  onGlobalSettings: () => void;
  onCollapse?: () => void;
}

interface PoolGroup {
  pool: PoolConfig;
  claimed: Worktree[];
  available: Worktree[];
}

// --- Worktrees Tab ---

interface WorktreesTabProps {
  worktrees: Worktree[];
  currentRepo: string | null;
  selectedWorktree: Worktree | null;
  pools?: PoolConfig[];
  worktreeActivity?: Record<string, WorktreeActivity>;
  starredWorktrees: Set<string>;
  worktreeOrder: string[];
  hasTaskPools: boolean;
  onWorktreeSelect: (worktree: Worktree | null) => void;
  onCreateWorktree: () => void;
  onSwitchWorktree?: () => void;
  onNewTask?: () => void;
  onArchiveWorktrees?: (worktrees: Worktree[]) => void;
  onToggleStar: (worktreePath: string) => void;
  onReorderWorktrees: (orderedPaths: string[]) => void;
}

function sortWorktreeList(
  worktrees: Worktree[],
  starred: Set<string>,
  order: string[],
): Worktree[] {
  const orderMap = new Map(order.map((p, i) => [p, i]));
  const maxOrder = order.length;
  return [...worktrees].sort((a, b) => {
    const aStarred = starred.has(a.path);
    const bStarred = starred.has(b.path);
    if (aStarred !== bStarred) return aStarred ? -1 : 1;
    const aOrder = orderMap.get(a.path) ?? maxOrder;
    const bOrder = orderMap.get(b.path) ?? maxOrder;
    return aOrder - bOrder;
  });
}

const SortableWorktreeItem: React.FC<{
  worktree: Worktree;
  children: React.ReactNode;
}> = ({ worktree, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: worktree.path });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
};

const WorktreesTab: React.FC<WorktreesTabProps> = ({
  worktrees,
  currentRepo,
  selectedWorktree,
  pools,
  worktreeActivity,
  starredWorktrees,
  worktreeOrder,
  hasTaskPools,
  onWorktreeSelect,
  onCreateWorktree,
  onSwitchWorktree,
  onNewTask,
  onArchiveWorktrees,
  onToggleStar,
  onReorderWorktrees,
}) => {
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sortMode, setSortMode] = useState<"pool" | "date">("pool");

  const activityTimes = useWorktreeActivityTimes(
    currentRepo,
    sortMode === "date",
  );

  const toggleSelected = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelectedPaths(new Set());
  };

  const isArchivable = (worktree: Worktree) => {
    if (worktree.path === currentRepo) return false; // base worktree
    const pool = findWorktreePool(worktree, pools);
    if (pool?.type === "recyclable") return false;
    return true;
  };
  const { baseWorktree, poolGroups, ungroupedClaimed, ungroupedAvailable } =
    useMemo(() => {
      const base = worktrees.find((w) => w.path === currentRepo);
      const lowerFilter = filter.toLowerCase();
      const matchesFilter = (w: Worktree) =>
        !lowerFilter ||
        (w.branch &&
          formatBranchName(w.branch).toLowerCase().includes(lowerFilter)) ||
        w.worktreeName.toLowerCase().includes(lowerFilter);
      const others = worktrees.filter(
        (w) => w.path !== currentRepo && !w.bare && matchesFilter(w),
      );

      if (!pools || pools.length === 0) {
        const claimed = sortWorktreeList(
          others.filter((w) => !isTmpBranch(w.branch)),
          starredWorktrees,
          worktreeOrder,
        );
        const available = others.filter((w) => isTmpBranch(w.branch));
        return {
          baseWorktree: base,
          poolGroups: [] as PoolGroup[],
          ungroupedClaimed: claimed,
          ungroupedAvailable: available,
        };
      }

      const grouped = new Set<string>();
      const groups: PoolGroup[] = pools.map((pool) => {
        const poolWorktrees = others.filter((w) =>
          w.worktreeName.startsWith(pool.prefix),
        );
        poolWorktrees.forEach((w) => grouped.add(w.path));
        return {
          pool,
          claimed: sortWorktreeList(
            poolWorktrees.filter((w) => !isTmpBranch(w.branch)),
            starredWorktrees,
            worktreeOrder,
          ),
          available: poolWorktrees.filter((w) => isTmpBranch(w.branch)),
        };
      });

      const ungrouped = others.filter((w) => !grouped.has(w.path));

      return {
        baseWorktree: base,
        poolGroups: groups,
        ungroupedClaimed: sortWorktreeList(
          ungrouped.filter((w) => !isTmpBranch(w.branch)),
          starredWorktrees,
          worktreeOrder,
        ),
        ungroupedAvailable: ungrouped.filter((w) => isTmpBranch(w.branch)),
      };
    }, [
      worktrees,
      currentRepo,
      pools,
      starredWorktrees,
      worktreeOrder,
      filter,
    ]);

  const hasAnyPoolGroups = poolGroups.length > 0;

  const dateSorted = useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    const matchesFilter = (w: Worktree) =>
      !lowerFilter ||
      (w.branch &&
        formatBranchName(w.branch).toLowerCase().includes(lowerFilter)) ||
      w.worktreeName.toLowerCase().includes(lowerFilter);
    return worktrees
      .filter((w) => !w.bare && matchesFilter(w))
      .sort((a, b) => {
        const ta = activityTimes[a.path] ?? 0;
        const tb = activityTimes[b.path] ?? 0;
        if (tb !== ta) return tb - ta;
        return a.worktreeName.localeCompare(b.worktreeName);
      });
  }, [worktrees, activityTimes, filter]);

  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Collect all claimed worktrees across all groups in display order for the reorder callback
  const allClaimedInOrder = useMemo(() => {
    const result: Worktree[] = [];
    for (const { claimed } of poolGroups) result.push(...claimed);
    result.push(...ungroupedClaimed);
    return result;
  }, [poolGroups, ungroupedClaimed]);

  const handleDragEnd = (event: DragEndEvent, claimedList: Worktree[]) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = claimedList.findIndex((w) => w.path === active.id);
    const newIndex = claimedList.findIndex((w) => w.path === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    // Build the new full order: start from allClaimedInOrder, apply the swap within this group
    const reordered = arrayMove(claimedList, oldIndex, newIndex);
    // Rebuild full order: replace the group's portion with the reordered version
    const groupPaths = new Set(claimedList.map((w) => w.path));
    const fullOrder: string[] = [];
    let groupInserted = false;
    for (const w of allClaimedInOrder) {
      if (groupPaths.has(w.path)) {
        if (!groupInserted) {
          fullOrder.push(...reordered.map((rw) => rw.path));
          groupInserted = true;
        }
      } else {
        fullOrder.push(w.path);
      }
    }
    if (!groupInserted) fullOrder.push(...reordered.map((rw) => rw.path));
    onReorderWorktrees(fullOrder);
  };

  const renderWorktreeItem = (
    worktree: Worktree,
    opts: {
      isBase?: boolean;
      isAvailable?: boolean;
      isDragOverlay?: boolean;
      activityTime?: number;
    } = {},
  ) => {
    const {
      isBase = false,
      isAvailable = false,
      isDragOverlay = false,
      activityTime,
    } = opts;
    const activity = worktreeActivity?.[worktree.path];
    const termCount = activity?.terminals ?? 0;
    const claudeCount = activity?.claudeSessions ?? 0;
    const canArchive = multiSelect && isArchivable(worktree);
    const isChecked = selectedPaths.has(worktree.path);
    const isStarred = starredWorktrees.has(worktree.path);
    const canStar = !isBase && !isAvailable;

    return (
      <div
        data-testid={`worktree-item-${worktree.branch || "main"}`}
        className={`group px-3 py-2 mb-0.5 cursor-pointer transition-colors border-l-[3px] rounded-none ${
          isDragOverlay
            ? "border-l-primary bg-base-200 shadow-lg opacity-95"
            : !multiSelect && selectedWorktree?.path === worktree.path
              ? "border-l-primary bg-primary/15"
              : multiSelect && isChecked
                ? "border-l-warning bg-warning/15"
                : "border-l-transparent hover:bg-base-content/5"
        } ${isAvailable ? "opacity-70 hover:opacity-100" : ""} ${draggingId === worktree.path && !isDragOverlay ? "opacity-30" : ""}`}
        onClick={() => {
          if (multiSelect && canArchive) {
            toggleSelected(worktree.path);
          } else if (!multiSelect) {
            onWorktreeSelect(worktree);
          }
        }}
      >
        <div className="flex items-center gap-2">
          {canArchive && (
            <input
              type="checkbox"
              className="checkbox checkbox-xs checkbox-warning"
              checked={isChecked}
              onChange={() => toggleSelected(worktree.path)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {(!multiSelect || !canArchive) && (
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${isAvailable ? "bg-warning" : "bg-success"}`}
              title={isAvailable ? "Available" : "Claimed"}
            />
          )}
          <div
            className="text-sm font-semibold leading-tight flex-1 min-w-0"
            title={formatBranchName(worktree.branch)}
          >
            {formatBranchName(worktree.branch)}
            {isBase && (
              <span className="badge badge-primary badge-xs ml-2 align-middle">
                base
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canStar && !multiSelect && (
              <button
                className={`text-xs leading-none px-0.5 transition-opacity ${isStarred ? "text-warning opacity-100" : "opacity-0 group-hover:opacity-60 text-base-content/40 hover:!opacity-100"}`}
                title={isStarred ? "Unstar" : "Star"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStar(worktree.path);
                }}
              >
                {isStarred ? "\u2605" : "\u2606"}
              </button>
            )}
            {(termCount > 0 || claudeCount > 0) && (
              <div className="flex items-center gap-1.5">
                {termCount > 0 && (
                  <span
                    className="text-[10px] text-base-content/60 flex items-center gap-0.5"
                    title={`${termCount} terminal${termCount > 1 ? "s" : ""}`}
                  >
                    &gt;_ {termCount}
                  </span>
                )}
                {claudeCount > 0 && (
                  <span
                    className="text-[10px] text-accent flex items-center gap-0.5"
                    title={`${claudeCount} Claude session${claudeCount > 1 ? "s" : ""}`}
                  >
                    &#9679; {claudeCount}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div
          className="text-[11px] text-base-content/50 font-mono leading-snug mt-0.5 flex items-center justify-between gap-2"
          title={worktree.path}
        >
          <span className="break-all min-w-0">{worktree.worktreeName}</span>
          {activityTime ? (
            <span className="shrink-0 text-base-content/40">
              {formatRelativeTime(activityTime)}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  const worktreeMap = useMemo(() => {
    const m = new Map<string, Worktree>();
    for (const w of worktrees) m.set(w.path, w);
    return m;
  }, [worktrees]);

  const renderSortableList = (claimed: Worktree[], available: Worktree[]) => (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e: DragStartEvent) =>
          setDraggingId(e.active.id as string)
        }
        onDragEnd={(e) => handleDragEnd(e, claimed)}
        onDragCancel={() => setDraggingId(null)}
      >
        <SortableContext
          items={claimed.map((w) => w.path)}
          strategy={verticalListSortingStrategy}
        >
          {claimed.map((w) => (
            <SortableWorktreeItem key={w.path} worktree={w}>
              {renderWorktreeItem(w)}
            </SortableWorktreeItem>
          ))}
        </SortableContext>
        <DragOverlay>
          {draggingId && worktreeMap.get(draggingId)
            ? renderWorktreeItem(worktreeMap.get(draggingId)!, {
                isDragOverlay: true,
              })
            : null}
        </DragOverlay>
      </DndContext>
      {available.map((w) => renderWorktreeItem(w, { isAvailable: true }))}
    </>
  );

  return (
    <>
      <div className="flex-1 overflow-y-auto mb-3">
        {worktrees.length === 0 ? (
          <p className="text-base-content/50 italic text-center mt-12">
            {currentRepo
              ? "No worktrees found"
              : "Select a repository to view worktrees"}
          </p>
        ) : (
          <>
            <div className="join w-full mb-2 px-1">
              <button
                className={`join-item btn btn-xs flex-1 ${sortMode === 'pool' ? 'btn-outline btn-primary' : 'btn-soft'}`}
                onClick={() => setSortMode('pool')}
              >
                By pool
              </button>
              <button
                className={`join-item btn btn-xs flex-1 ${sortMode === 'date' ? 'btn-outline btn-primary' : 'btn-soft'}`}
                onClick={() => setSortMode('date')}
              >
                By date
              </button>
            </div>
            {worktrees.length > 5 && (
              <div className="px-1 mb-2">
                <input
                  type="text"
                  className="input input-bordered input-sm w-full"
                  placeholder="Filter worktrees..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}
            {sortMode === "date" ? (
              dateSorted.length === 0 ? (
                <p className="text-base-content/50 italic text-center mt-8 text-sm">
                  No matching worktrees
                </p>
              ) : (
                dateSorted.map((w) =>
                  renderWorktreeItem(w, {
                    isBase: w.path === currentRepo,
                    isAvailable: isTmpBranch(w.branch),
                    activityTime: activityTimes[w.path],
                  }),
                )
              )
            ) : (
              <>
                {baseWorktree &&
                  !filter &&
                  renderWorktreeItem(baseWorktree, { isBase: true })}

                {poolGroups.map(({ pool, claimed, available }) => {
                  if (claimed.length === 0 && available.length === 0)
                    return null;
                  return (
                    <div className="mt-2" key={pool.prefix}>
                      <div className="flex items-center justify-between pr-1 mb-1">
                        <span className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide pl-1 pt-1">
                          {pool.name}
                        </span>
                      </div>
                      {renderSortableList(claimed, available)}
                    </div>
                  );
                })}

                {!hasAnyPoolGroups ? (
                  <>
                    {ungroupedClaimed.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide mb-2 pl-1 pt-1">
                          Claimed
                        </div>
                        {renderSortableList(ungroupedClaimed, [])}
                      </div>
                    )}
                    {ungroupedAvailable.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide mb-2 pl-1 pt-1">
                          Available
                        </div>
                        {ungroupedAvailable.map((w) =>
                          renderWorktreeItem(w, { isAvailable: true }),
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  (ungroupedClaimed.length > 0 ||
                    ungroupedAvailable.length > 0) && (
                    <div className="mt-2">
                      <div className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide mb-2 pl-1 pt-1">
                        Other
                      </div>
                      {renderSortableList(ungroupedClaimed, ungroupedAvailable)}
                    </div>
                  )
                )}
              </>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {multiSelect ? (
          <>
            <button
              className="btn btn-warning w-full"
              disabled={selectedPaths.size === 0}
              onClick={() => {
                const selected = worktrees.filter((w) =>
                  selectedPaths.has(w.path),
                );
                if (selected.length > 0 && onArchiveWorktrees) {
                  onArchiveWorktrees(selected);
                  exitMultiSelect();
                }
              }}
            >
              Archive {selectedPaths.size > 0 ? `${selectedPaths.size} ` : ""}
              Selected
            </button>
            <button
              className="btn btn-soft btn-neutral w-full"
              onClick={exitMultiSelect}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {hasTaskPools && onNewTask && (
              <button
                onClick={onNewTask}
                disabled={!currentRepo}
                className="btn btn-outline btn-success w-full"
              >
                New Task
              </button>
            )}
            <button
              data-testid="create-worktree-button"
              onClick={onCreateWorktree}
              disabled={!currentRepo}
              className="btn btn-soft btn-success w-full"
            >
              Create Worktree
            </button>
            {!hasAnyPoolGroups &&
              ungroupedAvailable.length > 0 &&
              onSwitchWorktree && (
                <button
                  data-testid="switch-worktree-button"
                  onClick={onSwitchWorktree}
                  disabled={!currentRepo}
                  className="btn btn-soft btn-neutral w-full"
                  title="Claim an available worktree for a branch"
                >
                  Switch Branch
                </button>
              )}
            {onArchiveWorktrees && worktrees.some((w) => isArchivable(w)) && (
              <button
                className="btn btn-soft btn-warning w-full"
                disabled={!currentRepo}
                onClick={() => setMultiSelect(true)}
              >
                Batch Archive...
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
};

// --- Automations Tab ---

interface AutomationsTabProps {
  currentRepo: string | null;
  subView: AutomationsSubView;
  onSubViewChange: (view: AutomationsSubView) => void;
}

const AutomationsTab: React.FC<AutomationsTabProps> = ({
  currentRepo,
  subView,
  onSubViewChange,
}) => {
  return (
    <>
      <div className="flex-1 overflow-y-auto mb-3">
        <div
          className={`px-3 py-2 mb-0.5 cursor-pointer transition-colors border-l-[3px] rounded-none ${
            subView === "running"
              ? "border-l-primary bg-primary/15"
              : "border-l-transparent hover:bg-base-content/5"
          }`}
          onClick={() => onSubViewChange("running")}
        >
          <div className="text-sm font-semibold leading-tight">
            Running Tasks
          </div>
          <div className="text-[11px] text-base-content/50 mt-0.5">
            Active and recent tasks
          </div>
        </div>
        <div
          className={`px-3 py-2 mb-0.5 cursor-pointer transition-colors border-l-[3px] rounded-none ${
            subView === "definitions"
              ? "border-l-primary bg-primary/15"
              : "border-l-transparent hover:bg-base-content/5"
          }`}
          onClick={() => onSubViewChange("definitions")}
        >
          <div className="text-sm font-semibold leading-tight">Definitions</div>
          <div className="text-[11px] text-base-content/50 mt-0.5">
            Manage automation definitions
          </div>
        </div>
      </div>
    </>
  );
};

// --- Sidebar ---

const Sidebar: React.FC<SidebarProps> = ({
  repositories,
  currentRepo,
  worktrees,
  selectedWorktree,
  pools,
  worktreeActivity,
  starredWorktrees,
  worktreeOrder,
  automationsSubView,
  onRepoSelect,
  onWorktreeSelect,
  onCreateWorktree,
  onConfigRepo,
  onSwitchWorktree,
  onClaimPool,
  onNewTask,
  activeTab,
  projects,
  selectedNode,
  pinnedFolders,
  onTogglePin,
  onNavigateWorktrees,
  onNavigateTracked,
  onNavigateProjects,
  onSelectNode,
  onOpenFile,
  onAddProject,
  onRemoveProject,
  onAutomationsSubViewChange,
  onArchiveWorktrees,
  onToggleStar,
  onReorderWorktrees,
  onGlobalSettings,
  onCollapse,
}) => {
  const hasTaskPools = pools?.some((p) => p.taskCommand) ?? false;

  return (
    <div className="bg-base-200 border-r border-base-300 flex flex-col p-2 h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          <img src="/many-shodan.png" alt="" className="w-12 h-12" />
          <h2 className="text-lg font-semibold">Many</h2>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onGlobalSettings}
            className="btn btn-soft btn-neutral btn-sm"
            title="Global settings"
          >
            &#9881;
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="btn btn-soft btn-neutral btn-sm"
              title="Hide sidebar"
            >
              &#x2039;
            </button>
          )}
        </div>
      </div>

      <div className="flex mb-2 border-b border-base-300">
        <button
          className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === "projects" ? "border-b-2 border-primary text-primary" : "text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => onNavigateProjects?.()}
        >
          Projects
        </button>
        <button
          className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === "worktrees" ? "border-b-2 border-primary text-primary" : "text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => onNavigateWorktrees?.()}
        >
          Worktrees
        </button>
        <button
          className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === "tracked" ? "border-b-2 border-primary text-primary" : "text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => onNavigateTracked?.()}
        >
          Tracked
        </button>
        {hasTaskPools && (
          <button
            className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === "automations" ? "border-b-2 border-primary text-primary" : "text-base-content/50 hover:text-base-content/80"}`}
            onClick={() => onAutomationsSubViewChange?.("running")}
          >
            Automations
          </button>
        )}
      </div>

      {activeTab !== "projects" && (
        <div className="mb-3 flex gap-2 items-center">
          <select
            data-testid="repo-selector"
            className="select select-bordered select-sm flex-1"
            value={currentRepo || ""}
            onChange={(e) => onRepoSelect(e.target.value || null)}
          >
            <option value="">Select a repository...</option>
            {repositories.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.name || repo.path}
              </option>
            ))}
          </select>
          {currentRepo && (
            <button
              data-testid="repo-config-button"
              onClick={onConfigRepo}
              className="btn btn-soft btn-neutral btn-sm"
              title="Configure repository settings"
            >
              ⚙️
            </button>
          )}
        </div>
      )}

      {activeTab === "projects" ? (
        <ProjectsTab
          projects={projects}
          selectedNode={selectedNode}
          onSelectNode={(n) => onSelectNode?.(n)}
          onOpenFile={(f) => onOpenFile?.(f)}
          onAddProject={() => onAddProject?.()}
          onRemoveProject={(p) => onRemoveProject?.(p)}
          worktreeActivity={worktreeActivity}
          pinnedFolders={pinnedFolders}
          onTogglePin={onTogglePin}
        />
      ) : activeTab === "tracked" ? (
        <div className="flex-1 overflow-y-auto mb-3">
          <p className="text-base-content/50 text-xs text-center mt-4 px-2">
            Tracked branches are shown in the main panel.
          </p>
        </div>
      ) : activeTab === "automations" && hasTaskPools ? (
        <AutomationsTab
          currentRepo={currentRepo}
          subView={automationsSubView ?? "running"}
          onSubViewChange={onAutomationsSubViewChange ?? (() => {})}
        />
      ) : (
        <WorktreesTab
          worktrees={worktrees}
          currentRepo={currentRepo}
          selectedWorktree={selectedWorktree}
          pools={pools}
          worktreeActivity={worktreeActivity}
          starredWorktrees={starredWorktrees}
          worktreeOrder={worktreeOrder}
          hasTaskPools={hasTaskPools}
          onWorktreeSelect={onWorktreeSelect}
          onCreateWorktree={onCreateWorktree}
          onSwitchWorktree={onSwitchWorktree}
          onNewTask={onNewTask}
          onArchiveWorktrees={onArchiveWorktrees}
          onToggleStar={onToggleStar}
          onReorderWorktrees={onReorderWorktrees}
        />
      )}
    </div>
  );
};

export default Sidebar;
