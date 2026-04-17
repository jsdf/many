import React, { useState, useEffect } from 'react'
import { getRpcClient } from '../rpc-client'

const TrackedItem: React.FC<{
  branch: string
  notes: string
  notesLoaded: boolean
  repoPath: string
  isOverlay?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLElement>
  onRemove: (branch: string) => void
  onNotesChange: (branch: string, notes: string) => void
}> = ({ branch, notes, notesLoaded, repoPath, isOverlay, dragHandleProps, onRemove, onNotesChange }) => {
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
      <div className="flex items-center gap-1 px-1 py-2">
        <span
          className="cursor-grab active:cursor-grabbing text-base-content/30 hover:text-base-content/60 px-1 shrink-0"
          title="Drag to reorder"
          {...dragHandleProps}
        >
          &#x2630;
        </span>
        <span
          className="text-base-content/40 text-xs w-4 shrink-0 cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
        <span className="font-semibold text-sm flex-1 min-w-0 truncate select-text cursor-text" title={branch}>
          {branch}
        </span>
        {prUrl && (
          <button
            className="btn btn-xs btn-primary btn-soft shrink-0"
            title="Open PR"
            onClick={() => window.open(prUrl, '_blank', 'noopener,noreferrer')}
          >
            PR
          </button>
        )}
        <button
          className="text-xs text-base-content/40 hover:text-error shrink-0 px-1"
          title="Remove from tracked"
          onClick={() => onRemove(branch)}
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

export default TrackedItem;
