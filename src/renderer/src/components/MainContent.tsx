import React, { useState, useCallback } from 'react'
import { Worktree } from '../types'
import TilingLayout, { Tile } from './TilingLayout'
import Terminal from './Terminal'

const formatBranchName = (branch?: string) => {
  if (!branch) return 'detached HEAD'
  return branch.replace(/^refs\/heads\//, '')
}

interface MainContentProps {
  selectedWorktree: Worktree | null
  currentRepo: string | null
  onArchiveWorktree: (worktree: Worktree) => Promise<void>
  onMergeWorktree: (worktree: Worktree) => void
  onRebaseWorktree: (worktree: Worktree) => void
}

interface WorktreeDetailsProps {
  worktree: Worktree
  onArchiveWorktree: (worktree: Worktree) => Promise<void>
  onMergeWorktree: (worktree: Worktree) => void
  onRebaseWorktree: (worktree: Worktree) => void
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({ 
  worktree, 
  onArchiveWorktree, 
  onMergeWorktree, 
  onRebaseWorktree 
}) => {
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAction = async (action: string, actionFn: () => Promise<boolean | void>) => {
    setIsLoading(action)
    setError(null)
    
    try {
      await actionFn()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setIsLoading(null)
    }
  }

  const archiveWorktree = async () => {
    const confirmed = confirm(`Are you sure you want to archive the worktree "${formatBranchName(worktree.branch)}"?\n\nThis will remove the working directory but keep the branch in git.`)
    if (!confirmed) return

    await handleAction('archive', async () => {
      await onArchiveWorktree(worktree)
    })
  }

  const mergeWorktree = () => {
    onMergeWorktree(worktree)
  }

  const rebaseWorktree = () => {
    onRebaseWorktree(worktree)
  }

  return (
    <div className="worktree-details-content">
      <div className="worktree-info">
        <h2>Worktree Overview</h2>
        <div className="info-grid">
          <div className="info-item">
            <label>Path:</label>
            <span>{worktree.path}</span>
          </div>
          <div className="info-item">
            <label>Branch:</label>
            <span>{worktree.branch || 'detached HEAD'}</span>
          </div>
        </div>
      </div>
      
      <div className="worktree-actions">
        <h3>Quick Actions</h3>
        <div className="action-buttons">
          <button className="btn btn-secondary" onClick={() => {
            window.electronAPI?.openInFileManager?.(worktree.path)
          }}>
            📁 Open Folder
          </button>
          <button className="btn btn-secondary" onClick={() => {
            window.electronAPI?.openInEditor?.(worktree.path)
          }}>
            📝 Open in Editor
          </button>
          <button className="btn btn-secondary" onClick={() => {
            window.electronAPI?.openInTerminal?.(worktree.path)
          }}>
            💻 Open in Terminal
          </button>
        </div>
        
        {error && <p className="error-message">{error}</p>}
      </div>

      <div className="worktree-management-actions">
        <h3>Worktree Management</h3>
        <div className="management-buttons">
          <button 
            className="btn btn-success"
            onClick={mergeWorktree}
            disabled={!worktree?.branch}
          >
            🔀 Merge Changes
          </button>
          
          <button 
            className="btn btn-info"
            onClick={rebaseWorktree}
            disabled={!worktree?.branch}
          >
            🌿 Rebase Branch
          </button>
          
          <button 
            className="btn btn-warning"
            onClick={archiveWorktree}
            disabled={isLoading === 'archive'}
          >
            📦 {isLoading === 'archive' ? 'Archiving...' : 'Archive Worktree'}
          </button>
        </div>
      </div>

      <div className="git-status">
        <h3>Git Status</h3>
        <div className="status-info">
          <p>Changes will appear here...</p>
        </div>
      </div>
    </div>
  )
}

const MainContent: React.FC<MainContentProps> = ({ 
  selectedWorktree, 
  onArchiveWorktree, 
  onMergeWorktree, 
  onRebaseWorktree 
}) => {
  const [tiles, setTiles] = useState<Tile[]>([])
  const [nextTerminalId, setNextTerminalId] = useState(1)

  // Initialize tiles when a worktree is selected
  React.useEffect(() => {
    if (selectedWorktree && tiles.length === 0) {
      const mainContentTile: Tile = {
        id: 'main-content',
        type: 'content',
        title: 'Worktree Details',
        component: (
          <WorktreeDetails 
            worktree={selectedWorktree} 
            onArchiveWorktree={onArchiveWorktree}
            onMergeWorktree={onMergeWorktree}
            onRebaseWorktree={onRebaseWorktree}
          />
        )
      }

      const firstTerminalTile: Tile = {
        id: 'terminal-1',
        type: 'terminal',
        title: 'Terminal 1',
        component: (
          <Terminal 
            workingDirectory={selectedWorktree.path}
            terminalId="terminal-1"
            onTitleChange={(title) => updateTileTitle('terminal-1', title)}
          />
        )
      }

      setTiles([mainContentTile, firstTerminalTile])
      setNextTerminalId(2)
    } else if (!selectedWorktree) {
      setTiles([])
      setNextTerminalId(1)
    }
  }, [selectedWorktree, onArchiveWorktree, onMergeWorktree, onRebaseWorktree])

  const updateTileTitle = useCallback((tileId: string, newTitle: string) => {
    setTiles(prevTiles => 
      prevTiles.map(tile => 
        tile.id === tileId ? { ...tile, title: newTitle } : tile
      )
    )
  }, [])

  const handleCloseTile = useCallback((tileId: string) => {
    setTiles(prevTiles => prevTiles.filter(tile => tile.id !== tileId))
    
    // If it's a terminal, clean up the session
    if (tileId.startsWith('terminal-')) {
      window.electronAPI.closeTerminal?.(tileId)
    }
  }, [])

  const handleSplitTile = useCallback((tileId: string, direction: 'horizontal' | 'vertical') => {
    if (!selectedWorktree) return

    const newTerminalId = `terminal-${nextTerminalId}`
    const newTile: Tile = {
      id: newTerminalId,
      type: 'terminal',
      title: `Terminal ${nextTerminalId}`,
      component: (
        <Terminal 
          workingDirectory={selectedWorktree.path}
          terminalId={newTerminalId}
          onTitleChange={(title) => updateTileTitle(newTerminalId, title)}
        />
      )
    }

    setTiles(prevTiles => [...prevTiles, newTile])
    setNextTerminalId(prev => prev + 1)
  }, [selectedWorktree, nextTerminalId, updateTileTitle])

  const handleAddClaudeTerminal = useCallback(() => {
    if (!selectedWorktree) return

    const claudeTerminalId = `claude-${nextTerminalId}`
    const claudeTile: Tile = {
      id: claudeTerminalId,
      type: 'terminal',
      title: `Claude Terminal`,
      component: (
        <Terminal 
          workingDirectory={selectedWorktree.path}
          terminalId={claudeTerminalId}
          onTitleChange={(title) => updateTileTitle(claudeTerminalId, title)}
          initialCommand="claude"
        />
      )
    }

    setTiles(prevTiles => [...prevTiles, claudeTile])
    setNextTerminalId(prev => prev + 1)
  }, [selectedWorktree, nextTerminalId, updateTileTitle])

  if (!selectedWorktree) {
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
            <div className="feature">
              <h3>💻 Integrated Terminals</h3>
              <p>Built-in terminal with tiling layout</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="main-content worktree-view">
      <div className="worktree-header">
        <div className="worktree-title">
          <h2>{selectedWorktree.branch || 'Worktree'}</h2>
          <span className="worktree-path">{selectedWorktree.path}</span>
        </div>
        <div className="worktree-controls">
          <button 
            className="btn btn-secondary" 
            onClick={() => handleSplitTile('', 'horizontal')}
            title="Add terminal"
          >
            + Terminal
          </button>
          <button 
            className="btn btn-primary" 
            onClick={() => handleAddClaudeTerminal()}
            title="Open Claude terminal"
          >
            🤖 Claude
          </button>
        </div>
      </div>
      
      <div className="tiling-container">
        <TilingLayout 
          tiles={tiles}
          onCloseTile={handleCloseTile}
          onSplitTile={handleSplitTile}
        />
      </div>
    </div>
  )
}

export default MainContent