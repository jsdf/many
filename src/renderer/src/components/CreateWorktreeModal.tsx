import React, { useState, useEffect } from 'react'

interface CreateWorktreeModalProps {
  currentRepo: string | null
  onClose: () => void
  onCreate: (branchName: string, baseBranch: string) => Promise<void>
}

const CreateWorktreeModal: React.FC<CreateWorktreeModalProps> = ({ currentRepo, onClose, onCreate }) => {
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultBranches = ['main', 'master', 'dev', 'develop', 'trunk']

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const loadBranches = async () => {
      if (!currentRepo) return
      
      setIsLoadingBranches(true)
      try {
        const repoBranches = await window.electronAPI.getBranches(currentRepo)
        setBranches(repoBranches)
        
        // Auto-select a sensible default base branch
        const defaultBranch = defaultBranches.find(branch => 
          repoBranches.includes(branch)
        )
        if (defaultBranch) {
          setBaseBranch(defaultBranch)
        } else if (repoBranches.length > 0) {
          setBaseBranch(repoBranches[0])
        }
      } catch (error) {
        console.error('Failed to load branches:', error)
        setError('Failed to load branches')
      } finally {
        setIsLoadingBranches(false)
      }
    }

    loadBranches()
  }, [currentRepo])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!branchName.trim()) {
      setError('Please enter a branch name')
      return
    }

    if (!baseBranch) {
      setError('Please select a base branch')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      await onCreate(branchName.trim(), baseBranch)
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
              <label htmlFor="base-branch-select">Base branch:</label>
              <select
                id="base-branch-select"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={isCreating || isLoadingBranches}
              >
                {isLoadingBranches ? (
                  <option value="">Loading branches...</option>
                ) : (
                  <>
                    {branches.map(branch => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
            
            <div className="form-group">
              <label htmlFor="branch-input">New branch name:</label>
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
              disabled={isCreating || !branchName.trim() || !baseBranch || isLoadingBranches}
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