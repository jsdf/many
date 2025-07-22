import React, { useState } from 'react'
import { Worktree } from '../types'

interface MainContentProps {
  selectedWorktree: Worktree | null
}

const MainContent: React.FC<MainContentProps> = ({ selectedWorktree }) => {
  const [isLoading, setIsLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAction = async (action: string, actionFn: () => Promise<boolean>) => {
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

  const openDirectory = () => handleAction('directory', () => 
    window.electronAPI.openDirectory(selectedWorktree!.path)
  )

  const openTerminal = () => handleAction('terminal', () => 
    window.electronAPI.openTerminal(selectedWorktree!.path)
  )

  const openVSCode = () => handleAction('vscode', () => 
    window.electronAPI.openVSCode(selectedWorktree!.path)
  )

  if (selectedWorktree) {
    return (
      <div className="main-content">
        <div className="worktree-details">
          <h2>Worktree Details</h2>
          <div className="worktree-info">
            <p><strong>Path:</strong> {selectedWorktree.path}</p>
            <p><strong>Branch:</strong> {selectedWorktree.branch || 'detached HEAD'}</p>
          </div>
          
          <div className="worktree-actions">
            <h3>Quick Actions</h3>
            <div className="action-buttons">
              <button 
                className="btn btn-primary"
                onClick={openDirectory}
                disabled={isLoading === 'directory'}
              >
                📁 {isLoading === 'directory' ? 'Opening...' : 'Open Folder'}
              </button>
              
              <button 
                className="btn btn-primary"
                onClick={openTerminal}
                disabled={isLoading === 'terminal'}
              >
                💻 {isLoading === 'terminal' ? 'Opening...' : 'Open Terminal'}
              </button>
              
              <button 
                className="btn btn-primary"
                onClick={openVSCode}
                disabled={isLoading === 'vscode'}
              >
                📝 {isLoading === 'vscode' ? 'Opening...' : 'Open in VS Code'}
              </button>
            </div>
            
            {error && <p className="error-message">{error}</p>}
          </div>
          
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