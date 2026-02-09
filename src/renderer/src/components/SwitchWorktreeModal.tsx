import React, { useState, useEffect } from 'react'
import { Worktree, isTmpBranch, GitStatus } from '../types'
import { client } from '../main'

interface SwitchWorktreeModalProps {
  currentRepo: string | null
  worktrees: Worktree[]
  onClose: () => void
  onSwitch: (worktreePath: string, branchName: string) => Promise<void>
}

const SwitchWorktreeModal: React.FC<SwitchWorktreeModalProps> = ({
  currentRepo,
  worktrees,
  onClose,
  onSwitch
}) => {
  const [branchName, setBranchName] = useState('')
  const [selectedWorktree, setSelectedWorktree] = useState<string>('')
  const [existingBranches, setExistingBranches] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [worktreeStatus, setWorktreeStatus] = useState<GitStatus | null>(null)

  // Filter to only show available worktrees
  const availableWorktrees = worktrees.filter(w =>
    w.path !== currentRepo && !w.bare && isTmpBranch(w.branch)
  )

  useEffect(() => {
    if (currentRepo) {
      loadBranches()
    }
    // Auto-select first available worktree
    if (availableWorktrees.length > 0 && !selectedWorktree) {
      setSelectedWorktree(availableWorktrees[0].path || '')
    }
  }, [currentRepo])

  useEffect(() => {
    if (selectedWorktree) {
      checkWorktreeStatus()
    }
  }, [selectedWorktree])

  const loadBranches = async () => {
    if (!currentRepo) return
    try {
      const branches = await client.getBranches.query({ repoPath: currentRepo })
      setExistingBranches(branches)
    } catch (err) {
      console.error('Failed to load branches:', err)
    }
  }

  const checkWorktreeStatus = async () => {
    if (!selectedWorktree) return
    try {
      const status = await client.getWorktreeStatus.query({ worktreePath: selectedWorktree })
      setWorktreeStatus(status)
    } catch (err) {
      console.error('Failed to get worktree status:', err)
      setWorktreeStatus(null)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!branchName.trim()) {
      setError('Branch name is required')
      return
    }

    if (!selectedWorktree) {
      setError('Please select a worktree')
      return
    }

    // Check for dirty state
    if (worktreeStatus && (worktreeStatus.hasChanges || worktreeStatus.hasStaged)) {
      const confirmed = confirm(
        'The selected worktree has uncommitted changes that will be lost. Continue?'
      )
      if (!confirmed) return

      // Clean the worktree
      try {
        await client.cleanWorktreeChanges.mutate({ worktreePath: selectedWorktree })
      } catch (err) {
        setError(`Failed to clean worktree: ${err}`)
        return
      }
    }

    setIsLoading(true)
    setError(null)

    try {
      await onSwitch(selectedWorktree, branchName.trim())
    } catch (err: any) {
      setError(err.message || 'Failed to switch worktree')
      setIsLoading(false)
    }
  }

  const branchExists = existingBranches.includes(branchName.trim())

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Switch Worktree to Branch</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="worktree-select">Select Worktree</label>
            <select
              id="worktree-select"
              value={selectedWorktree}
              onChange={e => setSelectedWorktree(e.target.value)}
              disabled={isLoading}
            >
              {availableWorktrees.length === 0 ? (
                <option value="">No available worktrees</option>
              ) : (
                availableWorktrees.map(w => (
                  <option key={w.path} value={w.path}>
                    {w.path?.split('/').pop()} ({w.branch?.replace(/^refs\/heads\//, '')})
                  </option>
                ))
              )}
            </select>
            {worktreeStatus && (worktreeStatus.hasChanges || worktreeStatus.hasStaged) && (
              <p className="form-warning">
                ⚠️ This worktree has uncommitted changes that will be discarded
              </p>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="branch-input">Branch Name</label>
            <input
              id="branch-input"
              type="text"
              value={branchName}
              onChange={e => setBranchName(e.target.value)}
              placeholder="e.g., feature/my-feature"
              disabled={isLoading}
              autoFocus
              list="branch-suggestions"
            />
            <datalist id="branch-suggestions">
              {existingBranches
                .filter(b => !b.startsWith('tmp-'))
                .map(b => (
                  <option key={b} value={b} />
                ))}
            </datalist>
            <p className="form-hint">
              {branchExists
                ? `Will checkout existing branch "${branchName}"`
                : branchName.trim()
                ? `Will create new branch "${branchName}" from default branch`
                : 'Enter a branch name to claim this worktree'}
            </p>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading || !branchName.trim() || !selectedWorktree}
            >
              {isLoading ? 'Switching...' : 'Switch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default SwitchWorktreeModal
