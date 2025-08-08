import React, { useState, useEffect } from 'react'
import { MergeOptions, GitStatus } from '../types'
import { client } from '../main'

interface MergeWorktreeModalProps {
  currentRepo: string | null
  fromBranch: string
  worktreePath: string
  onClose: () => void
  onMerge: (toBranch: string, options: MergeOptions) => Promise<void>
}

const MergeWorktreeModal: React.FC<MergeWorktreeModalProps> = ({ 
  currentRepo, 
  fromBranch, 
  worktreePath,
  onClose, 
  onMerge 
}) => {
  const [toBranch, setToBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [squash, setSquash] = useState(false)
  const [noFF, setNoFF] = useState(false)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const [message, setMessage] = useState('')
  const [isMerging, setIsMerging] = useState(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)

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
        
        // Filter out the current branch
        const availableBranches = repoBranches.filter(branch => branch !== fromBranch)
        setBranches(availableBranches)
        
        // Auto-select target branch based on configuration or defaults
        let selectedBranch = ''
        if (repoConfig.mainBranch && availableBranches.includes(repoConfig.mainBranch)) {
          selectedBranch = repoConfig.mainBranch
        } else {
          const defaultBranch = defaultBranches.find(branch => 
            availableBranches.includes(branch)
          )
          if (defaultBranch) {
            selectedBranch = defaultBranch
          } else if (availableBranches.length > 0) {
            selectedBranch = availableBranches[0]
          }
        }
        
        setToBranch(selectedBranch)
        
        // Set default commit message using git log
        if (selectedBranch) {
          try {
            const commitLog = await client.getCommitLog.query({ worktreePath, baseBranch: selectedBranch })
            if (commitLog) {
              setMessage(commitLog)
            } else {
              setMessage(`Merge ${fromBranch}`)
            }
          } catch (error) {
            console.error('Failed to get commit log:', error)
            setMessage(`Merge ${fromBranch}`)
          }
        } else {
          setMessage(`Merge ${fromBranch}`)
        }
      } catch (error) {
        console.error('Failed to load branches:', error)
        setError('Failed to load branches')
      } finally {
        setIsLoadingBranches(false)
      }
    }

    loadBranches()
  }, [currentRepo, fromBranch])

  useEffect(() => {
    const loadGitStatus = async () => {
      if (!worktreePath) return
      
      try {
        const status = await client.getWorktreeStatus.query({ worktreePath })
        setGitStatus(status)
      } catch (error) {
        console.error('Failed to load git status:', error)
        // Don't set error state for git status, just log it
      }
    }

    loadGitStatus()
  }, [worktreePath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!toBranch.trim()) {
      setError('Please select a target branch')
      return
    }

    if (!message.trim()) {
      setError('Please enter a merge message')
      return
    }

    setIsMerging(true)
    setError(null)

    try {
      await onMerge(toBranch, {
        squash,
        noFF,
        message: message.trim(),
        deleteWorktree,
        worktreePath
      })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to merge worktree')
    } finally {
      setIsMerging(false)
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
          <h3>Merge Worktree</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label>From branch:</label>
              <div className="branch-display">{fromBranch}</div>
            </div>
            
            <div className="form-group">
              <label htmlFor="to-branch-select">To branch:</label>
              <select
                id="to-branch-select"
                value={toBranch}
                onChange={(e) => setToBranch(e.target.value)}
                disabled={isMerging || isLoadingBranches}
              >
                {isLoadingBranches ? (
                  <option value="">Loading branches...</option>
                ) : (
                  <>
                    <option value="">Select target branch...</option>
                    {branches.map(branch => (
                      <option key={branch} value={branch}>
                        {branch}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
            
            {gitStatus && gitStatus.hasChanges && (
              <div className="warning-message">
                <strong>⚠️ Uncommitted changes detected</strong>
                <p>
                  There are uncommitted changes in the worktree. Please commit or stash your changes before merging.
                </p>
                {gitStatus.modified.length > 0 && (
                  <p>Modified files: {gitStatus.modified.join(', ')}</p>
                )}
                {gitStatus.not_added.length > 0 && (
                  <p>Untracked files: {gitStatus.not_added.join(', ')}</p>
                )}
                {gitStatus.created.length > 0 && (
                  <p>Created files: {gitStatus.created.join(', ')}</p>
                )}
                {gitStatus.deleted.length > 0 && (
                  <p>Deleted files: {gitStatus.deleted.join(', ')}</p>
                )}
              </div>
            )}
            
            <div className="form-group">
              <label htmlFor="merge-message">Merge message:</label>
              <textarea
                id="merge-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Merge commit message..."
                disabled={isMerging}
                rows={4}
              />
            </div>
            
            <div className="form-group">
              <label>Merge options:</label>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={squash}
                    onChange={(e) => setSquash(e.target.checked)}
                    disabled={isMerging}
                  />
                  Squash commits (combine all commits into one)
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={noFF}
                    onChange={(e) => setNoFF(e.target.checked)}
                    disabled={isMerging || squash}
                  />
                  Create merge commit (--no-ff)
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={deleteWorktree}
                    onChange={(e) => setDeleteWorktree(e.target.checked)}
                    disabled={isMerging}
                  />
                  Delete worktree after merging
                </label>
              </div>
            </div>
            
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onClose}
              disabled={isMerging}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary"
              disabled={isMerging || !toBranch.trim() || !message.trim() || isLoadingBranches || (gitStatus?.hasChanges === true)}
            >
              {isMerging ? 'Merging...' : 'Merge'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default MergeWorktreeModal