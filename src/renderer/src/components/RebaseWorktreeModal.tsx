import React, { useState, useEffect } from 'react'

interface RebaseWorktreeModalProps {
  currentRepo: string | null
  fromBranch: string
  worktreePath: string
  onClose: () => void
  onRebase: (ontoBranch: string) => Promise<void>
}

const RebaseWorktreeModal: React.FC<RebaseWorktreeModalProps> = ({ 
  currentRepo, 
  fromBranch,
  worktreePath,
  onClose, 
  onRebase 
}) => {
  const [ontoBranch, setOntoBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [isRebasing, setIsRebasing] = useState(false)
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
        const [repoBranches, repoConfig] = await Promise.all([
          window.electronAPI.getBranches(currentRepo),
          window.electronAPI.getRepoConfig(currentRepo)
        ])

        // Filter out the current branch since we can't rebase onto ourselves
        const availableBranches = repoBranches.filter(branch => branch !== fromBranch)
        setBranches(availableBranches)
        
        // Set default target branch
        let defaultBranch = repoConfig.mainBranch || 'main'
        
        // If the configured main branch doesn't exist or is the current branch, find an alternative
        if (!availableBranches.includes(defaultBranch)) {
          defaultBranch = defaultBranches.find(branch => availableBranches.includes(branch)) || availableBranches[0] || ''
        }
        
        setOntoBranch(defaultBranch)
      } catch (error) {
        console.error('Failed to load branches:', error)
        setError('Failed to load branch list')
        
        // Set fallback default branches
        const fallbackBranches = defaultBranches.filter(branch => branch !== fromBranch)
        setBranches(fallbackBranches)
        setOntoBranch(fallbackBranches[0] || '')
      } finally {
        setIsLoadingBranches(false)
      }
    }

    loadBranches()
  }, [currentRepo, fromBranch])

  const handleRebase = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!ontoBranch.trim()) {
      setError('Please select a target branch')
      return
    }

    if (ontoBranch === fromBranch) {
      setError('Cannot rebase branch onto itself')
      return
    }

    setIsRebasing(true)
    setError(null)

    try {
      await onRebase(ontoBranch)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Rebase failed')
    } finally {
      setIsRebasing(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Rebase Branch</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="modal-content">
          <p>
            Rebase <strong>{fromBranch}</strong> onto another branch.
          </p>
          
          <form onSubmit={handleRebase}>
            <div className="form-group">
              <label htmlFor="onto-branch">Target branch:</label>
              <div className="branch-select-container">
                <select
                  id="onto-branch"
                  value={ontoBranch}
                  onChange={(e) => setOntoBranch(e.target.value)}
                  disabled={isLoadingBranches || isRebasing}
                  required
                >
                  <option value="">Select target branch...</option>
                  {branches.map(branch => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
                {isLoadingBranches && <span className="loading-spinner">Loading...</span>}
              </div>
            </div>

            <div className="info-box">
              <p><strong>Note:</strong> This will rebase the current branch ({fromBranch}) onto {ontoBranch || 'the selected branch'}. The operation will replay your commits on top of the target branch.</p>
              <p><strong>Warning:</strong> Rebasing rewrites commit history. Only rebase branches that haven't been pushed or shared with others.</p>
            </div>

            {error && <div className="error-message">{error}</div>}
            
            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={isRebasing}>
                Cancel
              </button>
              <button 
                type="submit" 
                className="btn btn-primary" 
                disabled={isRebasing || isLoadingBranches || !ontoBranch}
              >
                {isRebasing ? 'Rebasing...' : 'Rebase'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

export default RebaseWorktreeModal