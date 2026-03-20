import React, { useState, useEffect } from 'react'
import { Worktree, PoolConfig, isTmpBranch, GitStatus, formatBranchName } from '../types'
import { client } from '../main'

interface SwitchWorktreeModalProps {
  currentRepo: string | null
  worktrees: Worktree[]
  poolFilter?: PoolConfig
  preSelectedWorktreePath?: string
  onClose: () => void
  onSwitch: (worktreePath: string, branchName: string) => Promise<void>
}

const SwitchWorktreeModal: React.FC<SwitchWorktreeModalProps> = ({
  currentRepo,
  worktrees,
  poolFilter,
  preSelectedWorktreePath,
  onClose,
  onSwitch
}) => {
  const [branchName, setBranchName] = useState('')
  const [selectedWorktree, setSelectedWorktree] = useState<string>(preSelectedWorktreePath || '')
  const [existingBranches, setExistingBranches] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [worktreeStatus, setWorktreeStatus] = useState<GitStatus | null>(null)

  const availableWorktrees = worktrees.filter(w => {
    if (w.path === currentRepo || w.bare || !isTmpBranch(w.branch)) return false;
    if (poolFilter) return w.worktreeName.startsWith(poolFilter.prefix);
    return true;
  })

  useEffect(() => {
    if (currentRepo) {
      loadBranches()
    }
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

    if (worktreeStatus && (worktreeStatus.hasChanges || worktreeStatus.hasStaged)) {
      const confirmed = confirm(
        'The selected worktree has uncommitted changes that will be lost. Continue?'
      )
      if (!confirmed) return

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">
            {poolFilter ? `Claim ${poolFilter.name} Worktree` : 'Switch Worktree to Branch'}
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-5">
            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="worktree-select">Select Worktree</label>
              <select
                id="worktree-select"
                className="select select-bordered w-full"
                value={selectedWorktree}
                onChange={e => setSelectedWorktree(e.target.value)}
                disabled={isLoading}
              >
                {availableWorktrees.length === 0 ? (
                  <option value="">No available worktrees</option>
                ) : (
                  availableWorktrees.map(w => (
                    <option key={w.path} value={w.path}>
                      {w.path?.split('/').pop()} ({formatBranchName(w.branch)})
                    </option>
                  ))
                )}
              </select>
              {worktreeStatus && (worktreeStatus.hasChanges || worktreeStatus.hasStaged) && (
                <p className="text-xs text-warning mt-1.5">
                  ⚠️ This worktree has uncommitted changes that will be discarded
                </p>
              )}
            </div>

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="branch-input">Branch Name</label>
              <input
                id="branch-input"
                type="text"
                className="input input-bordered w-full"
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
              <p className="text-xs text-base-content/50 mt-1.5">
                {branchExists
                  ? `Will checkout existing branch "${branchName}"`
                  : branchName.trim()
                  ? `Will create new branch "${branchName}" from default branch`
                  : 'Enter a branch name to claim this worktree'}
              </p>
            </div>

            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>

          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button
              type="button"
              className="btn btn-neutral"
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
