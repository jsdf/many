import React, { useState, useEffect, useCallback, useRef } from 'react'
import TopBar from './TopBar'
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
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Worktree } from '../types'
import { getRpcClient } from '../rpc-client'
import { getMuxNotes, setMuxNotes } from '../mux-client'
import BranchTypeahead from './BranchTypeahead'
import TrackedItem from './TrackedItem'

interface TrackedPanelProps {
  currentRepo: string
  starredBranches: Set<string>
  worktrees: Worktree[]
  hasTaskPools: boolean
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
  onGoToWorktree: (worktreePath: string) => void
  onNewTask: (branch: string) => void
}

interface TrackedItemData {
  branch: string
  notes: string
  notesLoaded: boolean
}

const SortableTrackedItem: React.FC<{ id: string; children: (dragHandleProps: React.HTMLAttributes<HTMLElement>) => React.ReactNode }> = ({ id, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {children({ ...listeners })}
    </div>
  );
};

type StatusFilter = 'all' | 'active' | 'idle';

const TrackedPanel: React.FC<TrackedPanelProps> = ({ currentRepo, starredBranches, worktrees, hasTaskPools, sidebarCollapsed, onExpandSidebar, onGoToWorktree, onNewTask }) => {
  const [trackedBranches, setTrackedBranches] = useState<string[]>([]);
  const [itemData, setItemData] = useState<Map<string, TrackedItemData>>(new Map());
  const [adding, setAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const mergedBranches = React.useMemo(() => {
    const set = new Set(trackedBranches);
    const extra = [...starredBranches].filter((b) => !set.has(b));
    return [...trackedBranches, ...extra];
  }, [trackedBranches, starredBranches]);

  const excludeSet = React.useMemo(() => new Set(mergedBranches), [mergedBranches]);

  const branchToWorktree = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const w of worktrees) {
      if (w.branch) {
        map.set(w.branch.replace(/^refs\/heads\//, ''), w.path);
      }
    }
    return map;
  }, [worktrees]);

  const hasActiveFilter = filterText !== '' || statusFilter !== 'all';

  const filteredBranches = React.useMemo(() => {
    if (!hasActiveFilter) return mergedBranches;
    const q = filterText.trim().toLowerCase();
    return mergedBranches.filter((branch) => {
      if (q) {
        const data = itemData.get(branch);
        const matchesBranch = branch.toLowerCase().includes(q);
        const matchesNotes = data?.notes?.toLowerCase().includes(q) ?? false;
        if (!matchesBranch && !matchesNotes) return false;
      }
      if (statusFilter === 'active') return branchToWorktree.has(branch);
      if (statusFilter === 'idle') return !branchToWorktree.has(branch);
      return true;
    });
  }, [mergedBranches, filterText, statusFilter, itemData, branchToWorktree, hasActiveFilter]);

  const loadTracked = useCallback(async () => {
    try {
      const branches = await getRpcClient().query("tracked.list", { repoPath: currentRepo });
      setTrackedBranches(branches);
    } catch (err) {
      console.error("Failed to load tracked branches:", err);
    }
  }, [currentRepo]);

  const loadNotes = useCallback(async (branches: string[]) => {
    const results = await Promise.all(
      branches.map(async (branch) => {
        try {
          const notes = await getMuxNotes(currentRepo, branch);
          return { branch, notes, notesLoaded: true };
        } catch {
          return { branch, notes: '', notesLoaded: true };
        }
      })
    );
    setItemData((prev) => {
      const next = new Map(prev);
      for (const r of results) {
        next.set(r.branch, r);
      }
      return next;
    });
  }, [currentRepo]);

  useEffect(() => {
    loadTracked();
  }, [loadTracked]);

  useEffect(() => {
    const unloaded = mergedBranches.filter((b) => !itemData.has(b));
    if (unloaded.length > 0) loadNotes(unloaded);
  }, [mergedBranches, itemData, loadNotes]);

  const handleAdd = async (value: string) => {
    if (adding) return;
    setAdding(true);
    try {
      const { branch } = await getRpcClient().query("tracked.add", {
        repoPath: currentRepo,
        input: value,
      });
      await loadTracked();
      loadNotes([branch]);
    } catch (err) {
      console.error("Failed to add tracked branch:", err);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (branch: string) => {
    setTrackedBranches((prev) => prev.filter((b) => b !== branch));
    try {
      await getRpcClient().query("tracked.remove", { repoPath: currentRepo, branch });
    } catch (err) {
      console.error("Failed to remove tracked branch:", err);
      loadTracked();
    }
  };

  const handleNotesChange = (branch: string, notes: string) => {
    setItemData((prev) => {
      const next = new Map(prev);
      next.set(branch, { branch, notes, notesLoaded: true });
      return next;
    });

    const existing = saveTimers.current.get(branch);
    if (existing) clearTimeout(existing);
    saveTimers.current.set(branch, setTimeout(() => {
      setMuxNotes(currentRepo, branch, notes).catch(() => {});
      saveTimers.current.delete(branch);
    }, 500));
  };

  const handleMoveToTop = (branch: string) => {
    const reordered = [branch, ...mergedBranches.filter((b) => b !== branch)];
    setTrackedBranches(reordered);
    getRpcClient().query("tracked.reorder", {
      repoPath: currentRepo,
      branches: reordered,
    }).catch((err) => {
      console.error("Failed to reorder tracked branches:", err);
      loadTracked();
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const sourceList = hasActiveFilter ? filteredBranches : mergedBranches;
    const oldIndex = sourceList.indexOf(active.id as string);
    const newIndex = sourceList.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;

    let reordered: string[];
    if (hasActiveFilter) {
      // Reorder within the full list by moving active.id to just before/after over.id
      reordered = mergedBranches.filter((b) => b !== active.id);
      const targetIdx = reordered.indexOf(over.id as string);
      const insertIdx = oldIndex < newIndex ? targetIdx + 1 : targetIdx;
      reordered.splice(insertIdx, 0, active.id as string);
    } else {
      reordered = arrayMove(mergedBranches, oldIndex, newIndex);
    }

    setTrackedBranches(reordered);
    getRpcClient().query("tracked.reorder", {
      repoPath: currentRepo,
      branches: reordered,
    }).catch((err) => {
      console.error("Failed to reorder tracked branches:", err);
      loadTracked();
    });
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        <h2 className="text-lg font-semibold m-0">Tracked Branches</h2>
      </TopBar>
      <div className="p-5 overflow-auto flex-1 min-h-0">

      <BranchTypeahead
        repoPath={currentRepo}
        exclude={excludeSet}
        disabled={adding}
        onAdd={handleAdd}
      />

      {mergedBranches.length > 0 && (
        <div className="flex items-center gap-2 mt-3 mb-2">
          <input
            type="text"
            className="input input-sm input-bordered flex-1 min-w-0 bg-base-200"
            placeholder="Filter branches..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <div className="flex gap-0.5">
            {(['all', 'active', 'idle'] as const).map((f) => (
              <button
                key={f}
                className={`btn btn-xs ${statusFilter === f ? 'btn-outline btn-primary' : 'btn-ghost text-base-content/50'}`}
                onClick={() => setStatusFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Idle'}
              </button>
            ))}
          </div>
        </div>
      )}

      {mergedBranches.length === 0 ? (
        <p className="text-base-content/50 text-sm italic mt-8 text-center">
          No tracked branches yet. Star a worktree or add a branch above.
        </p>
      ) : filteredBranches.length === 0 ? (
        <p className="text-base-content/50 text-sm italic mt-4 text-center">
          No branches match the current filter.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e: DragStartEvent) => setDraggingId(e.active.id as string)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <SortableContext items={filteredBranches} strategy={verticalListSortingStrategy}>
            {filteredBranches.map((branch) => {
              const data = itemData.get(branch);
              return (
                <SortableTrackedItem key={branch} id={branch}>
                  {(dragHandleProps) => (
                    <TrackedItem
                      branch={branch}
                      notes={data?.notes ?? ''}
                      notesLoaded={data?.notesLoaded ?? false}
                      repoPath={currentRepo}
                      worktreePath={branchToWorktree.get(branch)}
                      hasTaskPools={hasTaskPools}
                      onRemove={handleRemove}
                      onNotesChange={handleNotesChange}
                      onGoToWorktree={onGoToWorktree}
                      onNewTask={onNewTask}
                      onMoveToTop={handleMoveToTop}
                      dragHandleProps={dragHandleProps}
                    />
                  )}
                </SortableTrackedItem>
              );
            })}
          </SortableContext>
          <DragOverlay>
            {draggingId && (
              <TrackedItem
                branch={draggingId}
                notes={itemData.get(draggingId)?.notes ?? ''}
                notesLoaded={true}
                repoPath={currentRepo}
                isOverlay
                onRemove={() => {}}
                onNotesChange={() => {}}
              />
            )}
          </DragOverlay>
        </DndContext>
      )}
      </div>
    </div>
  );
};

export default TrackedPanel;
