import React, { useState, useEffect } from 'react'
import { client } from '../main'

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
  const [selectedExistingBranch, setSelectedExistingBranch] = useState('')

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
        const [repoBranches, repoConfig] = await Promise.all([
          client.getBranches.query({ repoPath: currentRepo }),
          client.getRepoConfig.query({ repoPath: currentRepo })
        ])
        setBranches(repoBranches)
        
        // Use configured main branch if available, otherwise sensible defaults
        let selectedBranch = ''
        if (repoConfig.mainBranch && repoBranches.includes(repoConfig.mainBranch)) {
          selectedBranch = repoConfig.mainBranch
        } else {
          const defaultBranch = defaultBranches.find(branch => 
            repoBranches.includes(branch)
          )
          if (defaultBranch) {
            selectedBranch = defaultBranch
          } else if (repoBranches.length > 0) {
            selectedBranch = repoBranches[0]
          }
        }
        
        setBaseBranch(selectedBranch)
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
    
    const hasNewBranchName = branchName.trim().length > 0
    const hasExistingBranchSelected = selectedExistingBranch.length > 0
    
    if (!hasNewBranchName && !hasExistingBranchSelected) {
      setError('Please enter a new branch name or select an existing branch')
      return
    }
    
    if (hasNewBranchName && hasExistingBranchSelected) {
      setError('Please use either a new branch name or select an existing branch, not both')
      return
    }

    if (hasNewBranchName && !baseBranch) {
      setError('Please select a base branch for the new branch')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      if (hasNewBranchName) {
        await onCreate(branchName.trim(), baseBranch)
      } else {
        // For existing branch, pass the existing branch name as both branch and base
        await onCreate(selectedExistingBranch, selectedExistingBranch)
      }
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
              <label htmlFor="branch-input">New branch name:</label>
              <input
                type="text"
                id="branch-input"
                data-testid="branch-name-input"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="e.g., username/feature-name, fix-bug, add-feature..."
                autoFocus
                disabled={isCreating}
              />
            </div>
            
            <div className="form-group">
              <label htmlFor="base-branch-select">Base branch (for new branch):</label>
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
              <label>— OR —</label>
            </div>
            
            <div className="form-group">
              <label htmlFor="existing-branch-select">Select existing branch:</label>
              <select
                id="existing-branch-select"
                value={selectedExistingBranch}
                onChange={(e) => setSelectedExistingBranch(e.target.value)}
                disabled={isCreating || isLoadingBranches}
              >
                <option value="">Choose an existing branch...</option>
                {!isLoadingBranches && branches.map(branch => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </div>
            
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button 
              type="button" 
              data-testid="create-worktree-cancel"
              className="btn btn-secondary" 
              onClick={onClose}
              disabled={isCreating}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              data-testid="create-worktree-submit"
              className="btn btn-primary"
              disabled={isCreating || isLoadingBranches || (!branchName.trim() && !selectedExistingBranch)}
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