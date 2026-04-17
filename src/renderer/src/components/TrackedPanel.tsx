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

const TrackedItem: React.FC<{
  branch: string
  notes: string
  notesLoaded: boolean
  repoPath: string
  isOverlay?: boolean
  onRemove: (branch: string) => void
  onNotesChange: (branch: string, notes: string) => void
}> = ({ branch, notes, notesLoaded, repoPath, isOverlay, onRemove, onNotesChange }) => {
  const [expanded, setExpanded] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRpcClient().query("repo.githubLink", { repoPath, branch }).then((link) => {
      if (!cancelled && link?.type === 'pr') setPrUrl(link.url);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [repoPath, branch]);

  return (
    <div className={`border border-base-300 rounded-lg mb-2 ${isOverlay ? 'shadow-lg bg-base-100' : 'bg-base-100'}`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-base-content/40 text-xs w-4">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
        <span className="font-semibold text-sm flex-1 min-w-0 truncate">{branch}</span>
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            PR
          </a>
        )}
        <button
          className="text-xs text-base-content/40 hover:text-error shrink-0 px-1"
          title="Remove from tracked"
          onClick={(e) => { e.stopPropagation(); onRemove(branch); }}
        >
          &times;
        </button>
      </div>
      {expanded && notesLoaded && (
        <div className="px-3 pb-3">
          <textarea
            className="textarea textarea-bordered w-full bg-base-200 text-sm font-mono leading-relaxed"
            rows={4}
            placeholder="Notes..."
            value={notes}
            onChange={(e) => onNotesChange(branch, e.target.value)}
          />
        </div>
      )}
    </div>
  );
};

const TrackedPanel: React.FC<TrackedPanelProps> = ({ currentRepo, starredBranches }) => {
  const [trackedBranches, setTodoBranches] = useState<string[]>([]);
  const [itemData, setItemData] = useState<Map<string, TrackedItemData>>(new Map());
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Compute the merged list: tracked branches + starred branches not already tracked
  const mergedBranches = React.useMemo(() => {
    const set = new Set(trackedBranches);
    const extra = [...starredBranches].filter((b) => !set.has(b));
    return [...trackedBranches, ...extra];
  }, [trackedBranches, starredBranches]);

  const loadTracked = useCallback(async () => {
    try {
      const branches = await getRpcClient().query("tracked.list", { repoPath: currentRepo });
      setTodoBranches(branches);
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

  // Load notes for any branches we haven't loaded yet
  useEffect(() => {
    const unloaded = mergedBranches.filter((b) => !itemData.has(b));
    if (unloaded.length > 0) loadNotes(unloaded);
  }, [mergedBranches, itemData, loadNotes]);

  const handleAdd = async () => {
    if (!addInput.trim() || adding) return;
    setAdding(true);
    try {
      const { branch } = await getRpcClient().query("tracked.add", {
        repoPath: currentRepo,
        input: addInput.trim(),
      });
      setAddInput('');
      await loadTracked();
      // Load notes for the new branch
      loadNotes([branch]);
    } catch (err) {
      console.error("Failed to add tracked branch:", err);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (branch: string) => {
    setTodoBranches((prev) => prev.filter((b) => b !== branch));
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
    setTodoBranches(reordered);
    getRpcClient().query("tracked.reorder", {
      repoPath: currentRepo,
      branches: reordered,
    }).catch((err) => {
      console.error("Failed to reorder tracked branches:", err);
      loadTracked();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="p-5 overflow-auto h-full w-full min-w-0">
      <h2 className="text-lg font-semibold mb-4">Tracked Branches</h2>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          className="input input-bordered input-sm flex-1"
          placeholder="Branch name, PR number, or PR URL..."
          value={addInput}
          onChange={(e) => setAddInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={adding}
        />
        <button
          className="btn btn-sm btn-primary"
          onClick={handleAdd}
          disabled={!addInput.trim() || adding}
        >
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>

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
