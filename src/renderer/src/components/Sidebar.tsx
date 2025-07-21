import React from 'react'
import { Repository, Worktree } from '../types'

interface SidebarProps {
  repositories: Repository[]
  currentRepo: string | null
  worktrees: Worktree[]
  selectedWorktree: Worktree | null
  onRepoSelect: (repoPath: string | null) => void
  onWorktreeSelect: (worktree: Worktree | null) => void
  onAddRepo: () => void
  onCreateWorktree: () => void
}

const Sidebar: React.FC<SidebarProps> = ({
  repositories,
  currentRepo,
  worktrees,
  selectedWorktree,
  onRepoSelect,
  onWorktreeSelect,
  onAddRepo,
  onCreateWorktree
}) => {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Worktrees</h2>
        <button onClick={onAddRepo} className="btn btn-secondary">
          Add Repo
        </button>
      </div>
      
      <div className="repo-selector">
        <select 
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
      </div>
      
      <div className="worktree-list">
        {worktrees.length === 0 ? (
          <p className="empty-state">
            {currentRepo ? 'No worktrees found' : 'Select a repository to view worktrees'}
          </p>
        ) : (
          worktrees.map((worktree, index) => (
            <div
              key={index}
              className={`worktree-item ${selectedWorktree === worktree ? 'active' : ''}`}
              onClick={() => onWorktreeSelect(worktree)}
            >
              <div className="worktree-path">{worktree.path}</div>
              <div className="worktree-branch">{worktree.branch || 'detached HEAD'}</div>
            </div>
          ))
        )}
      </div>
      
      <button 
        onClick={onCreateWorktree}
        disabled={!currentRepo}
        className="btn btn-primary"
      >
        + Create Worktree
      </button>
    </div>
  )
}

export default Sidebar