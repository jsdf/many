import React, { useState, useEffect } from 'react'

interface AddRepoModalProps {
  onClose: () => void
  onAdd: (repoPath: string) => Promise<void>
}

const AddRepoModal: React.FC<AddRepoModalProps> = ({ onClose, onAdd }) => {
  const [repoPath, setRepoPath] = useState('')
  const [isAdding, setIsAdding] = useState(false)
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
    
    if (!repoPath.trim()) {
      setError('Please enter a repository path')
      return
    }

    setIsAdding(true)
    setError(null)

    try {
      await onAdd(repoPath.trim())
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to add repository')
    } finally {
      setIsAdding(false)
    }
  }

  const handleBrowse = async () => {
    try {
      const folderPath = await window.electronAPI.selectFolder()
      if (folderPath) {
        setRepoPath(folderPath)
      }
    } catch (error) {
      console.error('Failed to select folder:', error)
      setError('Failed to open folder picker')
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
          <h3>Add Repository</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="repo-path-input">Repository path:</label>
              <div className="path-input-group">
                <input
                  type="text"
                  id="repo-path-input"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="/path/to/your/repo"
                  autoFocus
                  disabled={isAdding}
                />
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={handleBrowse}
                  disabled={isAdding}
                >
                  Browse...
                </button>
              </div>
            </div>
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onClose}
              disabled={isAdding}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary"
              disabled={isAdding || !repoPath.trim()}
            >
              {isAdding ? 'Adding...' : 'Add Repository'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default AddRepoModal