import React, { useMemo } from 'react'
import { Repository, Worktree, isTmpBranch } from '../types'

const formatBranchName = (branch?: string | null) => {
  if (!branch) return 'detached HEAD'
  return branch.replace(/^refs\/heads\//, '')
}

interface SidebarProps {
  repositories: Repository[]
  currentRepo: string | null
  worktrees: Worktree[]
  selectedWorktree: Worktree | null
  onRepoSelect: (repoPath: string | null) => void
  onWorktreeSelect: (worktree: Worktree | null) => void
  onAddRepo: () => void
  onCreateWorktree: () => void
  onConfigRepo: () => void
  onSwitchWorktree?: () => void
}

const Sidebar: React.FC<SidebarProps> = ({
  repositories,
  currentRepo,
  worktrees,
  selectedWorktree,
  onRepoSelect,
  onWorktreeSelect,
  onAddRepo,
  onCreateWorktree,
  onConfigRepo,
  onSwitchWorktree
}) => {
  // Separate worktrees into categories
  const { baseWorktree, claimedWorktrees, availableWorktrees } = useMemo(() => {
    const base = worktrees.find(w => w.path === currentRepo);
    const others = worktrees.filter(w => w.path !== currentRepo && !w.bare);

    const claimed = others.filter(w => !isTmpBranch(w.branch));
    const available = others.filter(w => isTmpBranch(w.branch));

    return {
      baseWorktree: base,
      claimedWorktrees: claimed,
      availableWorktrees: available
    };
  }, [worktrees, currentRepo]);

  const renderWorktreeItem = (worktree: Worktree, isBase = false, isAvailable = false) => (
    <div
      key={worktree.path}
      data-testid={`worktree-item-${worktree.branch || 'main'}`}
      className={`worktree-item ${selectedWorktree?.path === worktree.path ? 'active' : ''} ${isAvailable ? 'available' : ''}`}
      onClick={() => onWorktreeSelect(worktree)}
    >
      <div className="worktree-header">
        <span className={`worktree-status-dot ${isAvailable ? 'available' : 'claimed'}`} title={isAvailable ? 'Available' : 'Claimed'} />
        <div className="worktree-branch" title={formatBranchName(worktree.branch)}>
          {formatBranchName(worktree.branch)}
          {isBase && <span className="worktree-tag base">base</span>}
        </div>
      </div>
      <div className="worktree-dirname" title={worktree.path}>{worktree.path}</div>
    </div>
  );

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Worktrees</h2>
        <button data-testid="add-repo-button" onClick={onAddRepo} className="btn btn-secondary">
          Add Repo
        </button>
      </div>

      <div className="repo-selector">
        <select
          data-testid="repo-selector"
          value={currentRepo || ''}
          onChange={(e) => onRepoSelect(e.target.value || null)}
        >
          <option value="">Select a repository...</option>
          {repositories.map(repo => (
            <option key={repo.path} value={repo.path}>
              {repo.name || repo.path}
            </option>
          ))}
        </select>
        {currentRepo && (
          <button
            data-testid="repo-config-button"
            onClick={onConfigRepo}
            className="btn btn-secondary repo-config-btn"
            title="Configure repository settings"
          >
            ⚙️
          </button>
        )}
      </div>

      <div className="worktree-list">
        {worktrees.length === 0 ? (
          <p className="empty-state">
            {currentRepo ? 'No worktrees found' : 'Select a repository to view worktrees'}
          </p>
        ) : (
          <>
            {/* Base worktree */}
            {baseWorktree && renderWorktreeItem(baseWorktree, true, false)}

            {/* Claimed worktrees */}
            {claimedWorktrees.length > 0 && (
              <div className="worktree-section">
                <div className="worktree-section-header">Claimed</div>
                {claimedWorktrees.map(w => renderWorktreeItem(w, false, false))}
              </div>
            )}

            {/* Available worktrees */}
            {availableWorktrees.length > 0 && (
              <div className="worktree-section">
                <div className="worktree-section-header">Available</div>
                {availableWorktrees.map(w => renderWorktreeItem(w, false, true))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="sidebar-actions">
        <button
          data-testid="create-worktree-button"
          onClick={onCreateWorktree}
          disabled={!currentRepo}
          className="btn btn-primary"
        >
          + Create Worktree
        </button>
        {availableWorktrees.length > 0 && onSwitchWorktree && (
          <button
            data-testid="switch-worktree-button"
            onClick={onSwitchWorktree}
            disabled={!currentRepo}
            className="btn btn-secondary"
            title="Claim an available worktree for a branch"
          >
            Switch Branch
          </button>
        )}
      </div>
    </div>
  )
}

export default Sidebar
