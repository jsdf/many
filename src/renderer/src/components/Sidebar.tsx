import React, { useMemo } from 'react'
import { Repository, Worktree, PoolConfig, isTmpBranch, formatBranchName, findWorktreePool } from '../types'

interface SidebarProps {
  repositories: Repository[]
  currentRepo: string | null
  worktrees: Worktree[]
  selectedWorktree: Worktree | null
  pools?: PoolConfig[]
  onRepoSelect: (repoPath: string | null) => void
  onWorktreeSelect: (worktree: Worktree | null) => void
  onAddRepo: () => void
  onCreateWorktree: () => void
  onConfigRepo: () => void
  onSwitchWorktree?: () => void
  onClaimPool?: (pool: PoolConfig) => void
  onNewTask?: () => void
  onGlobalSettings: () => void
}

interface PoolGroup {
  pool: PoolConfig;
  claimed: Worktree[];
  available: Worktree[];
}

const Sidebar: React.FC<SidebarProps> = ({
  repositories,
  currentRepo,
  worktrees,
  selectedWorktree,
  pools,
  onRepoSelect,
  onWorktreeSelect,
  onAddRepo,
  onCreateWorktree,
  onConfigRepo,
  onSwitchWorktree,
  onClaimPool,
  onNewTask,
  onGlobalSettings
}) => {
  const { baseWorktree, poolGroups, ungroupedClaimed, ungroupedAvailable } = useMemo(() => {
    const base = worktrees.find(w => w.path === currentRepo);
    const others = worktrees.filter(w => w.path !== currentRepo && !w.bare);

    if (!pools || pools.length === 0) {
      // No pools configured — fall back to flat claimed/available
      const claimed = others.filter(w => !isTmpBranch(w.branch));
      const available = others.filter(w => isTmpBranch(w.branch));
      return {
        baseWorktree: base,
        poolGroups: [] as PoolGroup[],
        ungroupedClaimed: claimed,
        ungroupedAvailable: available
      };
    }

    // Group worktrees by pool
    const grouped = new Set<string>();
    const groups: PoolGroup[] = pools.map(pool => {
      const poolWorktrees = others.filter(w => w.worktreeName.startsWith(pool.prefix));
      poolWorktrees.forEach(w => grouped.add(w.path));
      return {
        pool,
        claimed: poolWorktrees.filter(w => !isTmpBranch(w.branch)),
        available: poolWorktrees.filter(w => isTmpBranch(w.branch))
      };
    });

    // Ungrouped worktrees
    const ungrouped = others.filter(w => !grouped.has(w.path));

    return {
      baseWorktree: base,
      poolGroups: groups,
      ungroupedClaimed: ungrouped.filter(w => !isTmpBranch(w.branch)),
      ungroupedAvailable: ungrouped.filter(w => isTmpBranch(w.branch))
    };
  }, [worktrees, currentRepo, pools]);

  const renderWorktreeItem = (worktree: Worktree, isBase = false, isAvailable = false) => (
    <div
      key={worktree.path}
      data-testid={`worktree-item-${worktree.branch || 'main'}`}
      className={`worktree-item ${selectedWorktree?.path === worktree.path ? 'active' : ''} ${isAvailable ? 'available' : ''}`}
      onClick={() => onWorktreeSelect(worktree)}
    >
      <div className="worktree-item-header">
        <span className={`worktree-status-dot ${isAvailable ? 'available' : 'claimed'}`} title={isAvailable ? 'Available' : 'Claimed'} />
        <div className="worktree-branch" title={formatBranchName(worktree.branch)}>
          {formatBranchName(worktree.branch)}
          {isBase && <span className="worktree-tag base">base</span>}
        </div>
      </div>
      <div className="worktree-dirname" title={worktree.path}>{worktree.path}</div>
    </div>
  );

  const hasAnyPoolGroups = poolGroups.length > 0;
  const hasTaskPools = pools?.some(p => p.taskCommand) ?? false;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-title">
          <img src="/many-shodan.png" alt="" className="sidebar-icon" />
          <h2>Worktrees</h2>
        </div>
        <div className="sidebar-header-actions">
          <button onClick={onGlobalSettings} className="btn btn-secondary" title="Global settings">
            &#9881;
          </button>
          <button data-testid="add-repo-button" onClick={onAddRepo} className="btn btn-secondary">
            Add Repo
          </button>
        </div>
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

            {/* Pool groups */}
            {poolGroups.map(({ pool, claimed, available }) => {
              if (claimed.length === 0 && available.length === 0) return null;
              return (
                <div className="worktree-section" key={pool.prefix}>
                  <div className="worktree-section-header-row">
                    <span className="worktree-section-header">{pool.name}</span>
                    {pool.type === 'recyclable' && available.length > 0 && onClaimPool && (
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClaimPool(pool);
                        }}
                        title={`Claim an available ${pool.name} worktree`}
                      >
                        Claim
                      </button>
                    )}
                  </div>
                  {claimed.map(w => renderWorktreeItem(w, false, false))}
                  {available.map(w => renderWorktreeItem(w, false, true))}
                </div>
              );
            })}

            {/* Ungrouped worktrees */}
            {!hasAnyPoolGroups ? (
              <>
                {ungroupedClaimed.length > 0 && (
                  <div className="worktree-section">
                    <div className="worktree-section-header">Claimed</div>
                    {ungroupedClaimed.map(w => renderWorktreeItem(w, false, false))}
                  </div>
                )}
                {ungroupedAvailable.length > 0 && (
                  <div className="worktree-section">
                    <div className="worktree-section-header">Available</div>
                    {ungroupedAvailable.map(w => renderWorktreeItem(w, false, true))}
                  </div>
                )}
              </>
            ) : (
              (ungroupedClaimed.length > 0 || ungroupedAvailable.length > 0) && (
                <div className="worktree-section">
                  <div className="worktree-section-header">Other</div>
                  {ungroupedClaimed.map(w => renderWorktreeItem(w, false, false))}
                  {ungroupedAvailable.map(w => renderWorktreeItem(w, false, true))}
                </div>
              )
            )}
          </>
        )}
      </div>

      <div className="sidebar-actions">
        {hasTaskPools && onNewTask && (
          <button
            onClick={onNewTask}
            disabled={!currentRepo}
            className="btn btn-success"
          >
            New Task
          </button>
        )}
        <button
          data-testid="create-worktree-button"
          onClick={onCreateWorktree}
          disabled={!currentRepo}
          className="btn btn-primary"
        >
          + Create Worktree
        </button>
        {!hasAnyPoolGroups && ungroupedAvailable.length > 0 && onSwitchWorktree && (
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
