import React, { useState, useEffect } from 'react'
import { getRpcClient } from '../rpc-client'

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

export default TrackedItem;
