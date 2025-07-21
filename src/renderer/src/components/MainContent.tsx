import React from 'react'
import { Worktree } from '../types'

interface MainContentProps {
  selectedWorktree: Worktree | null
}

const MainContent: React.FC<MainContentProps> = ({ selectedWorktree }) => {
  if (selectedWorktree) {
    // TODO: Implement worktree details view
    return (
      <div className="main-content">
        <div className="worktree-details">
          <h2>Worktree Details</h2>
          <p><strong>Path:</strong> {selectedWorktree.path}</p>
          <p><strong>Branch:</strong> {selectedWorktree.branch || 'detached HEAD'}</p>
          {/* TODO: Add integrated terminal, review tool, etc. */}
        </div>
      </div>
    )
  }

  return (
    <div className="main-content">
      <div className="welcome">
        <h1>Many Worktree Manager</h1>
        <p>Manage git worktrees for parallel development with AI tools</p>
        <div className="features">
          <div className="feature">
            <h3>🌿 Multiple Worktrees</h3>
            <p>Work on different features simultaneously</p>
          </div>
          <div className="feature">
            <h3>🤖 AI Integration</h3>
            <p>Generate branch names from prompts</p>
          </div>
          <div className="feature">
            <h3>⚡ Quick Setup</h3>
            <p>Create worktrees with a single click</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MainContent