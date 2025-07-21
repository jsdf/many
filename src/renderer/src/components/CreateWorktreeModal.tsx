import React, { useState, useEffect } from 'react'

interface CreateWorktreeModalProps {
  onClose: () => void
  onCreate: (branchName: string) => Promise<void>
}

const CreateWorktreeModal: React.FC<CreateWorktreeModalProps> = ({ onClose, onCreate }) => {
  const [branchName, setBranchName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!branchName.trim()) {
      setError('Please enter a branch name')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      await onCreate(branchName.trim())
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create worktree')
    } finally {
      setIsCreating(false)
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="modal show" onClick={handleBackdropClick}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>Create New Worktree</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="branch-input">Branch name:</label>
              <input
                type="text"
                id="branch-input"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="e.g., username/feature-name, fix-bug, add-feature..."
                autoFocus
                disabled={isCreating}
              />
            </div>
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onClose}
              disabled={isCreating}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary"
              disabled={isCreating || !branchName.trim()}
            >
              {isCreating ? 'Creating...' : 'Create Worktree'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default CreateWorktreeModal