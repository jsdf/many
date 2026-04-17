import React, { useState, useEffect, useCallback, useRef } from 'react'
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
import { getRpcClient } from '../rpc-client'
import BranchTypeahead from './BranchTypeahead'
import TrackedItem from './TrackedItem'

interface TrackedPanelProps {
  currentRepo: string
  starredBranches: Set<string>
}

interface TrackedItemData {
  branch: string
  notes: string
  notesLoaded: boolean
}

const SortableTrackedItem: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
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
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
};

const TrackedPanel: React.FC<TrackedPanelProps> = ({ currentRepo, starredBranches }) => {
  const [trackedBranches, setTrackedBranches] = useState<string[]>([]);
  const [itemData, setItemData] = useState<Map<string, TrackedItemData>>(new Map());
  const [adding, setAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
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
          const notes = await getRpcClient().query("worktree.getNotes", {
            repoPath: currentRepo,
            branch,
          });
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
      getRpcClient().query("worktree.setNotes", {
        repoPath: currentRepo,
        branch,
        notes,
      }).catch(() => {});
      saveTimers.current.delete(branch);
    }, 500));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = mergedBranches.indexOf(active.id as string);
    const newIndex = mergedBranches.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(mergedBranches, oldIndex, newIndex);
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
    <div className="p-5 overflow-auto h-full w-full min-w-0">
      <h2 className="text-lg font-semibold mb-4">Tracked Branches</h2>

      <BranchTypeahead
        repoPath={currentRepo}
        exclude={excludeSet}
        disabled={adding}
        onAdd={handleAdd}
      />

      {mergedBranches.length === 0 ? (
        <p className="text-base-content/50 text-sm italic mt-8 text-center">
          No tracked branches yet. Star a worktree or add a branch above.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(e: DragStartEvent) => setDraggingId(e.active.id as string)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <SortableContext items={mergedBranches} strategy={verticalListSortingStrategy}>
            {mergedBranches.map((branch) => {
              const data = itemData.get(branch);
              return (
                <SortableTrackedItem key={branch} id={branch}>
                  <TrackedItem
                    branch={branch}
                    notes={data?.notes ?? ''}
                    notesLoaded={data?.notesLoaded ?? false}
                    repoPath={currentRepo}
                    onRemove={handleRemove}
                    onNotesChange={handleNotesChange}
                  />
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
  );
};

export default TrackedPanel;
