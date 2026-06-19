import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { Worktree, GitStatus, ChangeHandlingOption, formatBranchName } from '../types'
import { getRpcClient } from '../rpc-client'

interface ReleaseWorktreeModalProps {
  currentRepo: string | null
  worktree: Worktree
  onClose: () => void
  onRelease: () => Promise<void>
}

const ReleaseWorktreeModal: React.FC<ReleaseWorktreeModalProps> = ({
  currentRepo,
  worktree,
  onClose,
  onRelease
}) => {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isReleasing, setIsReleasing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showForceOption, setShowForceOption] = useState(false)
  const [changeHandling, setChangeHandling] = useState<ChangeHandlingOption>('stash')
  const [commitMessage, setCommitMessage] = useState('')

  const branchName = formatBranchName(worktree.branch)

  useEffect(() => {
    loadStatus()
  }, [worktree.path])

  const loadStatus = async () => {
    if (!worktree.path) return

    setIsLoading(true)
    try {
      const gitStatus = await getRpcClient().query("worktree.status", { worktreePath: worktree.path })
      setStatus(gitStatus)
    } catch (err) {
      console.error('Failed to load worktree status:', err)
      setError('Failed to load worktree status')
    } finally {
      setIsLoading(false)
    }
  }

  const handleRelease = async (force: boolean = false) => {
    if (!worktree.path || !currentRepo) return

    setIsReleasing(true)
    setError(null)
    setShowForceOption(false)

    try {
      if (!force && status && (status.hasChanges || status.hasStaged)) {
        switch (changeHandling) {
          case 'stash':
            await getRpcClient().query("worktree.stash", {
              worktreePath: worktree.path,
              message: `Release stash from ${branchName}`
            })
            break

          case 'commit':
            if (!commitMessage.trim()) {
              setError('Commit message is required')
              setIsReleasing(false)
              return
            }
            await getRpcClient().query("worktree.commit", {
              worktreePath: worktree.path,
              message: commitMessage.trim()
            })
            break

          case 'amend':
            await getRpcClient().query("worktree.amend", {
              worktreePath: worktree.path
            })
            break

          case 'clean':
            await getRpcClient().query("worktree.clean", {
              worktreePath: worktree.path
            })
            break

          case 'cancel':
            onClose()
            return
        }
      }

      await getRpcClient().query("worktree.release", {
        repoPath: currentRepo,
        worktreePath: worktree.path,
        force
      })

      await onRelease()
    } catch (err: any) {
      setError(err.message || 'Failed to release worktree')
      setShowForceOption(true)
      setIsReleasing(false)
    }
  }

  const hasChanges = status && (status.hasChanges || status.hasStaged)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Release Worktree</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="p-5">
          <p className="mb-2">
            Release worktree <strong>{worktree.path?.split('/').pop()}</strong> back to the pool.
          </p>
          <p className="text-sm text-base-content/60 mb-2">
            Current branch: <strong>{branchName}</strong>
          </p>
          <p className="text-sm text-base-content/60 mb-4">
            The branch will still exist and can be reclaimed later with "Switch Branch".
          </p>

          {isLoading ? (
            <p className="text-base-content/60 italic">Loading worktree status...</p>
          ) : hasChanges ? (
            <div className="mt-4">
              <h4 className="text-sm font-semibold mb-3 text-warning">Uncommitted Changes</h4>
              <div className="bg-base-100 rounded p-3 mb-4">
                {status.staged.length > 0 && (
                  <p className="text-xs my-1 text-success">Staged: {status.staged.length} file(s)</p>
                )}
                {status.modified.length > 0 && (
                  <p className="text-xs my-1 text-warning">Modified: {status.modified.length} file(s)</p>
                )}
                {status.not_added.length > 0 && (
                  <p className="text-xs my-1 text-base-content/60">Untracked: {status.not_added.length} file(s)</p>
                )}
                {status.deleted.length > 0 && (
                  <p className="text-xs my-1 text-error">Deleted: {status.deleted.length} file(s)</p>
                )}
              </div>

              <div className="mb-4">
                <label className="block mb-2 text-sm font-medium">How would you like to handle these changes?</label>
                <div className="flex flex-col gap-2 mt-2">
                  {[
                    { value: 'stash', label: 'Stash', hint: 'Save changes to stash for later', hintClass: 'text-base-content/60' },
                    { value: 'commit', label: 'Commit', hint: 'Create a new commit with these changes', hintClass: 'text-base-content/60' },
                    { value: 'amend', label: 'Amend', hint: 'Add changes to the last commit', hintClass: 'text-base-content/60' },
                    { value: 'clean', label: 'Discard', hint: 'Permanently delete all uncommitted changes', hintClass: 'text-error' },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className="flex items-start gap-2.5 px-3 py-2.5 bg-base-100 border border-base-300 rounded cursor-pointer hover:border-base-content/30 transition-colors"
                    >
                      <input
                        type="radio"
                        name="changeHandling"
                        value={opt.value}
                        checked={changeHandling === opt.value}
                        onChange={() => setChangeHandling(opt.value as ChangeHandlingOption)}
                        disabled={isReleasing}
                        className="radio radio-sm mt-0.5"
                      />
                      <div>
                        <strong className="text-sm block">{opt.label}</strong>
                        <p className={`text-xs mt-0.5 ${opt.hintClass}`}>{opt.hint}</p>
                      </div>
                    </label>
                  ))}
                </div>

                {changeHandling === 'commit' && (
                  <div className="mt-4">
                    <label className="block mb-2 text-sm font-medium" htmlFor="commit-message">Commit Message</label>
                    <input
                      id="commit-message"
                      type="text"
                      className="input input-bordered w-full"
                      value={commitMessage}
                      onChange={e => setCommitMessage(e.target.value)}
                      placeholder="Enter commit message"
                      disabled={isReleasing}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-success">Worktree is clean. Ready to release.</p>
          )}

          {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-base-300">
          <button
            type="button"
            className="btn btn-outline btn-neutral"
            onClick={onClose}
            disabled={isReleasing}
          >
            Cancel
          </button>
          {showForceOption && (
            <button
              type="button"
              className="btn btn-warning"
              onClick={() => handleRelease(true)}
              disabled={isReleasing}
              title="Force release, discarding submodule and checkout errors"
            >
              {isReleasing ? 'Force Releasing...' : 'Force Release'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline btn-primary"
            onClick={() => handleRelease(false)}
            disabled={isLoading || isReleasing || (changeHandling === 'commit' && !!hasChanges && !commitMessage.trim())}
          >
            {isReleasing ? 'Releasing...' : 'Release'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ReleaseWorktreeModal
