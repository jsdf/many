import React, { useState, useEffect } from 'react'
import { MergeOptions, GitStatus } from '../types'
import { getRpcClient } from '../rpc-client'

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
          getRpcClient().query("branch.list", { repoPath: currentRepo }),
          getRpcClient().query("repo.getConfig", { repoPath: currentRepo })
        ])

        const availableBranches = repoBranches.filter(branch => branch !== fromBranch)
        setBranches(availableBranches)

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

        if (selectedBranch) {
          try {
            const commitLog = await getRpcClient().query("worktree.commitLog", { worktreePath, baseBranch: selectedBranch })
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
        const status = await getRpcClient().query("worktree.status", { worktreePath })
        setGitStatus(status)
      } catch (error) {
        console.error('Failed to load git status:', error)
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Merge Worktree</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-5">
            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium">From branch:</label>
              <div className="bg-base-100 border border-base-300 rounded px-3 py-2.5 font-mono text-sm text-base-content/60">
                {fromBranch}
              </div>
            </div>

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="to-branch-select">To branch:</label>
              <select
                id="to-branch-select"
                className="select select-bordered w-full"
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
              <div className="mb-5 p-3 bg-warning/10 border border-warning/30 rounded-lg">
                <strong>⚠️ Uncommitted changes detected</strong>
                <p className="mt-1 text-sm">
                  There are uncommitted changes in the worktree. Please commit or stash your changes before merging.
                </p>
                {gitStatus.modified.length > 0 && (
                  <p className="text-sm mt-1">Modified files: {gitStatus.modified.join(', ')}</p>
                )}
                {gitStatus.not_added.length > 0 && (
                  <p className="text-sm mt-1">Untracked files: {gitStatus.not_added.join(', ')}</p>
                )}
                {gitStatus.created.length > 0 && (
                  <p className="text-sm mt-1">Created files: {gitStatus.created.join(', ')}</p>
                )}
                {gitStatus.deleted.length > 0 && (
                  <p className="text-sm mt-1">Deleted files: {gitStatus.deleted.join(', ')}</p>
                )}
              </div>
            )}

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="merge-message">Merge message:</label>
              <textarea
                id="merge-message"
                className="textarea textarea-bordered w-full"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Merge commit message..."
                disabled={isMerging}
                rows={4}
              />
            </div>

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium">Merge options:</label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={squash}
                    onChange={(e) => setSquash(e.target.checked)}
                    disabled={isMerging}
                  />
                  Squash commits (combine all commits into one)
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={noFF}
                    onChange={(e) => setNoFF(e.target.checked)}
                    disabled={isMerging || squash}
                  />
                  Create merge commit (--no-ff)
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={deleteWorktree}
                    onChange={(e) => setDeleteWorktree(e.target.checked)}
                    disabled={isMerging}
                  />
                  Delete worktree after merging
                </label>
              </div>
            </div>

            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>
          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button
              type="button"
              className="btn btn-outline btn-neutral"
              onClick={onClose}
              disabled={isMerging}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-outline btn-primary"
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
