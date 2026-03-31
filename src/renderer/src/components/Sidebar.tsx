import React, { useMemo, useState } from 'react'
import { Repository, Worktree, PoolConfig, isTmpBranch, formatBranchName, findWorktreePool } from '../types'
import TaskQueuePanel from './TaskQueuePanel'

interface WorktreeActivity {
  terminals: number
  claudeSessions: number
}

interface SidebarProps {
  repositories: Repository[]
  currentRepo: string | null
  worktrees: Worktree[]
  selectedWorktree: Worktree | null
  pools?: PoolConfig[]
  worktreeActivity?: Record<string, WorktreeActivity>
  onRepoSelect: (repoPath: string | null) => void
  onWorktreeSelect: (worktree: Worktree | null) => void
  onCreateWorktree: () => void
  onConfigRepo: () => void
  onSwitchWorktree?: () => void
  onClaimPool?: (pool: PoolConfig) => void
  onNewTask?: () => void
  onAutomations?: () => void
  onGlobalSettings: () => void
  onCollapse?: () => void
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
  worktreeActivity,
  onRepoSelect,
  onWorktreeSelect,
  onCreateWorktree,
  onConfigRepo,
  onSwitchWorktree,
  onClaimPool,
  onNewTask,
  onAutomations,
  onGlobalSettings,
  onCollapse
}) => {
  const { baseWorktree, poolGroups, ungroupedClaimed, ungroupedAvailable } = useMemo(() => {
    const base = worktrees.find(w => w.path === currentRepo);
    const others = worktrees.filter(w => w.path !== currentRepo && !w.bare);

    if (!pools || pools.length === 0) {
      const claimed = others.filter(w => !isTmpBranch(w.branch));
      const available = others.filter(w => isTmpBranch(w.branch));
      return {
        baseWorktree: base,
        poolGroups: [] as PoolGroup[],
        ungroupedClaimed: claimed,
        ungroupedAvailable: available
      };
    }

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

    const ungrouped = others.filter(w => !grouped.has(w.path));

    return {
      baseWorktree: base,
      poolGroups: groups,
      ungroupedClaimed: ungrouped.filter(w => !isTmpBranch(w.branch)),
      ungroupedAvailable: ungrouped.filter(w => isTmpBranch(w.branch))
    };
  }, [worktrees, currentRepo, pools]);

  const renderWorktreeItem = (worktree: Worktree, isBase = false, isAvailable = false) => {
    const activity = worktreeActivity?.[worktree.path];
    const termCount = activity?.terminals ?? 0;
    const claudeCount = activity?.claudeSessions ?? 0;

    return (
      <div
        key={worktree.path}
        data-testid={`worktree-item-${worktree.branch || 'main'}`}
        className={`px-3 py-2 mb-0.5 cursor-pointer transition-colors border-l-[3px] rounded-none ${
          selectedWorktree?.path === worktree.path
            ? 'border-l-primary bg-primary/15'
            : 'border-l-transparent hover:bg-base-content/5'
        } ${isAvailable ? 'opacity-70 hover:opacity-100' : ''}`}
        onClick={() => onWorktreeSelect(worktree)}
      >
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${isAvailable ? 'bg-warning' : 'bg-success'}`}
            title={isAvailable ? 'Available' : 'Claimed'}
          />
          <div className="text-sm font-semibold leading-tight flex-1 min-w-0" title={formatBranchName(worktree.branch)}>
            {formatBranchName(worktree.branch)}
            {isBase && <span className="badge badge-primary badge-xs ml-2 align-middle">base</span>}
          </div>
          {(termCount > 0 || claudeCount > 0) && (
            <div className="flex items-center gap-1.5 shrink-0">
              {termCount > 0 && (
                <span className="text-[10px] text-base-content/60 flex items-center gap-0.5" title={`${termCount} terminal${termCount > 1 ? 's' : ''}`}>
                  &gt;_ {termCount}
                </span>
              )}
              {claudeCount > 0 && (
                <span className="text-[10px] text-accent flex items-center gap-0.5" title={`${claudeCount} Claude session${claudeCount > 1 ? 's' : ''}`}>
                  &#9679; {claudeCount}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="text-[11px] text-base-content/50 font-mono break-all leading-snug mt-0.5" title={worktree.path}>
          {worktree.worktreeName}
        </div>
      </div>
    );
  };

  const [activeTab, setActiveTab] = useState<'worktrees' | 'taskqueue'>('worktrees');

  const hasAnyPoolGroups = poolGroups.length > 0;
  const hasTaskPools = pools?.some(p => p.taskCommand) ?? false;

  return (
    <div className="bg-base-200 border-r border-base-300 flex flex-col p-2 h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2">
          <img src="/many-shodan.png" alt="" className="w-12 h-12" />
          <h2 className="text-lg font-semibold">Worktrees</h2>
        </div>
        <div className="flex gap-1.5">
          <button onClick={onGlobalSettings} className="btn btn-soft btn-neutral btn-sm" title="Global settings">
            &#9881;
          </button>
          {onCollapse && (
            <button onClick={onCollapse} className="btn btn-soft btn-neutral btn-sm" title="Hide sidebar">
              &#x2039;
            </button>
          )}
        </div>
      </div>

      <div className="mb-3 flex gap-2 items-center">
        <select
          data-testid="repo-selector"
          className="select select-bordered select-sm flex-1"
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
            className="btn btn-soft btn-neutral btn-sm"
            title="Configure repository settings"
          >
            ⚙️
          </button>
        )}
      </div>

      {hasTaskPools && (
        <div className="flex mb-2 border-b border-base-300">
          <button
            className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === 'worktrees' ? 'border-b-2 border-primary text-primary' : 'text-base-content/50 hover:text-base-content/80'}`}
            onClick={() => setActiveTab('worktrees')}
          >
            Worktrees
          </button>
          <button
            className={`flex-1 text-xs py-1.5 font-semibold transition-colors ${activeTab === 'taskqueue' ? 'border-b-2 border-primary text-primary' : 'text-base-content/50 hover:text-base-content/80'}`}
            onClick={() => setActiveTab('taskqueue')}
          >
            Task Queue
          </button>
        </div>
      )}

      {activeTab === 'taskqueue' && hasTaskPools ? (
        <TaskQueuePanel currentRepo={currentRepo} />
      ) : (
        <div className="flex-1 overflow-y-auto mb-3">
          {worktrees.length === 0 ? (
            <p className="text-base-content/50 italic text-center mt-12">
              {currentRepo ? 'No worktrees found' : 'Select a repository to view worktrees'}
            </p>
          ) : (
            <>
              {baseWorktree && renderWorktreeItem(baseWorktree, true, false)}

              {poolGroups.map(({ pool, claimed, available }) => {
                if (claimed.length === 0 && available.length === 0) return null;
                return (
                  <div className="mt-2" key={pool.prefix}>
                    <div className="flex items-center justify-between pr-1 mb-1">
                      <span className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide pl-1 pt-1">
                        {pool.name}
                      </span>
                    </div>
                    {claimed.map(w => renderWorktreeItem(w, false, false))}
                    {available.map(w => renderWorktreeItem(w, false, true))}
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
                      {ungroupedClaimed.map(w => renderWorktreeItem(w, false, false))}
                    </div>
                  )}
                  {ungroupedAvailable.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide mb-2 pl-1 pt-1">
                        Available
                      </div>
                      {ungroupedAvailable.map(w => renderWorktreeItem(w, false, true))}
                    </div>
                  )}
                </>
              ) : (
                (ungroupedClaimed.length > 0 || ungroupedAvailable.length > 0) && (
                  <div className="mt-2">
                    <div className="text-[10px] font-semibold text-base-content/50 uppercase tracking-wide mb-2 pl-1 pt-1">
                      Other
                    </div>
                    {ungroupedClaimed.map(w => renderWorktreeItem(w, false, false))}
                    {ungroupedAvailable.map(w => renderWorktreeItem(w, false, true))}
                  </div>
                )
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {hasTaskPools && onNewTask && (
          <div className="flex gap-2">
            <button
              onClick={onNewTask}
              disabled={!currentRepo}
              className="btn btn-success flex-1"
            >
              New Task
            </button>
            {onAutomations && (
              <button
                onClick={onAutomations}
                disabled={!currentRepo}
                className="btn btn-soft btn-primary"
                title="Automations"
              >
                Auto
              </button>
            )}
          </div>
        )}
        <button
          data-testid="create-worktree-button"
          onClick={onCreateWorktree}
          disabled={!currentRepo}
          className="btn btn-soft btn-success w-full"
        >
          Create Worktree
        </button>
        {!hasAnyPoolGroups && ungroupedAvailable.length > 0 && onSwitchWorktree && (
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
      </div>
    </div>
  )
}

export default Sidebar
