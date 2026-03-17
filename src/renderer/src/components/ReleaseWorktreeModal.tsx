import React, { useState, useEffect } from 'react'
import { Worktree, GitStatus, ChangeHandlingOption, formatBranchName } from '../types'
import { client } from '../main'

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
      const gitStatus = await client.getWorktreeStatus.query({ worktreePath: worktree.path })
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
      // Handle dirty state based on selected option
      if (!force && status && (status.hasChanges || status.hasStaged)) {
        switch (changeHandling) {
          case 'stash':
            await client.stashWorktreeChanges.mutate({
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
            await client.commitWorktreeChanges.mutate({
              worktreePath: worktree.path,
              message: commitMessage.trim()
            })
            break

          case 'amend':
            await client.amendWorktreeChanges.mutate({
              worktreePath: worktree.path
            })
            break

          case 'clean':
            await client.cleanWorktreeChanges.mutate({
              worktreePath: worktree.path
            })
            break

          case 'cancel':
            onClose()
            return
        }
      }

      // Release the worktree
      await client.releaseWorktree.mutate({
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Release Worktree</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-content">
          <p>
            Release worktree <strong>{worktree.path?.split('/').pop()}</strong> back to the pool.
          </p>
          <p className="text-muted">
            Current branch: <strong>{branchName}</strong>
          </p>
          <p className="text-muted">
            The branch will still exist and can be reclaimed later with "Switch Branch".
          </p>

          {isLoading ? (
            <p>Loading worktree status...</p>
          ) : hasChanges ? (
            <div className="release-changes">
              <h4>Uncommitted Changes</h4>
              <div className="change-summary">
                {status.staged.length > 0 && (
                  <p className="change-staged">Staged: {status.staged.length} file(s)</p>
                )}
                {status.modified.length > 0 && (
                  <p className="change-modified">Modified: {status.modified.length} file(s)</p>
                )}
                {status.not_added.length > 0 && (
                  <p className="change-untracked">Untracked: {status.not_added.length} file(s)</p>
                )}
                {status.deleted.length > 0 && (
                  <p className="change-deleted">Deleted: {status.deleted.length} file(s)</p>
                )}
              </div>

              <div className="form-group">
                <label>How would you like to handle these changes?</label>
                <div className="radio-group">
                  <label className="radio-option">
                    <input
                      type="radio"
                      name="changeHandling"
                      value="stash"
                      checked={changeHandling === 'stash'}
                      onChange={() => setChangeHandling('stash')}
                      disabled={isReleasing}
                    />
                    <div>
                      <strong>Stash</strong>
                      <p className="radio-hint">Save changes to stash for later</p>
                    </div>
                  </label>

                  <label className="radio-option">
                    <input
                      type="radio"
                      name="changeHandling"
                      value="commit"
                      checked={changeHandling === 'commit'}
                      onChange={() => setChangeHandling('commit')}
                      disabled={isReleasing}
                    />
                    <div>
                      <strong>Commit</strong>
                      <p className="radio-hint">Create a new commit with these changes</p>
                    </div>
                  </label>

                  <label className="radio-option">
                    <input
                      type="radio"
                      name="changeHandling"
                      value="amend"
                      checked={changeHandling === 'amend'}
                      onChange={() => setChangeHandling('amend')}
                      disabled={isReleasing}
                    />
                    <div>
                      <strong>Amend</strong>
                      <p className="radio-hint">Add changes to the last commit</p>
                    </div>
                  </label>

                  <label className="radio-option">
                    <input
                      type="radio"
                      name="changeHandling"
                      value="clean"
                      checked={changeHandling === 'clean'}
                      onChange={() => setChangeHandling('clean')}
                      disabled={isReleasing}
                    />
                    <div>
                      <strong>Discard</strong>
                      <p className="radio-hint warning">Permanently delete all uncommitted changes</p>
                    </div>
                  </label>
                </div>

                {changeHandling === 'commit' && (
                  <div className="form-group" style={{ marginTop: '1rem' }}>
                    <label htmlFor="commit-message">Commit Message</label>
                    <input
                      id="commit-message"
                      type="text"
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

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
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
            className="btn btn-primary"
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
