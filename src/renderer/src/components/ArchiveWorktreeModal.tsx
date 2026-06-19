import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { Worktree, GitStatus, ChangeHandlingOption, formatBranchName } from '../types'
import { getRpcClient } from '../rpc-client'

interface ArchiveWorktreeModalProps {
  currentRepo: string | null
  worktrees: Worktree[]
  onClose: () => void
  onArchive: () => Promise<void>
}

interface WorktreeArchiveState {
  worktree: Worktree
  status: GitStatus | null
  isLoading: boolean
  error: string | null
}

const ArchiveWorktreeModal: React.FC<ArchiveWorktreeModalProps> = ({
  currentRepo,
  worktrees,
  onClose,
  onArchive,
}) => {
  const [worktreeStates, setWorktreeStates] = useState<WorktreeArchiveState[]>([])
  const [isArchiving, setIsArchiving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changeHandling, setChangeHandling] = useState<ChangeHandlingOption>('commit')
  const [commitMessage, setCommitMessage] = useState('wip changes')
  const [noVerify, setNoVerify] = useState(false)

  useEffect(() => {
    const initial = worktrees.map(w => ({
      worktree: w,
      status: null as GitStatus | null,
      isLoading: true,
      error: null as string | null,
    }))
    setWorktreeStates(initial)

    worktrees.forEach((w, i) => {
      if (!w.path) return
      getRpcClient().query("worktree.status", { worktreePath: w.path })
        .then(status => {
          setWorktreeStates(prev => prev.map((s, j) =>
            j === i ? { ...s, status, isLoading: false } : s
          ))
        })
        .catch(err => {
          setWorktreeStates(prev => prev.map((s, j) =>
            j === i ? { ...s, isLoading: false, error: String(err) } : s
          ))
        })
    })
  }, [worktrees])

  const anyLoading = worktreeStates.some(s => s.isLoading)
  const anyDirty = worktreeStates.some(s => s.status && (s.status.hasChanges || s.status.hasStaged))

  const handleArchive = async () => {
    if (!currentRepo) return
    setIsArchiving(true)
    setError(null)

    try {
      // Handle dirty worktrees first
      for (const state of worktreeStates) {
        if (!state.worktree.path) continue
        const hasDirty = state.status && (state.status.hasChanges || state.status.hasStaged)
        if (!hasDirty) continue

        switch (changeHandling) {
          case 'stash':
            await getRpcClient().query("worktree.stash", {
              worktreePath: state.worktree.path,
              message: `Archive stash from ${formatBranchName(state.worktree.branch)}`
            })
            break
          case 'commit':
            if (!commitMessage.trim()) {
              setError('Commit message is required')
              setIsArchiving(false)
              return
            }
            await getRpcClient().query("worktree.commit", {
              worktreePath: state.worktree.path,
              message: commitMessage.trim(),
              noVerify,
            })
            break
          case 'amend':
            await getRpcClient().query("worktree.amend", {
              worktreePath: state.worktree.path,
              noVerify,
            })
            break
          case 'clean':
            await getRpcClient().query("worktree.clean", {
              worktreePath: state.worktree.path,
            })
            break
          case 'cancel':
            onClose()
            return
        }
      }

      // Archive all worktrees
      for (const state of worktreeStates) {
        if (!state.worktree.path) continue
        await getRpcClient().query("worktree.archive", {
          repoPath: currentRepo,
          worktreePath: state.worktree.path,
          force: true,
        })
      }

      await onArchive()
    } catch (err: any) {
      setError(err.message || 'Failed to archive worktree(s)')
      setIsArchiving(false)
    }
  }

  const single = worktrees.length === 1

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">
            Archive {single ? 'Worktree' : `${worktrees.length} Worktrees`}
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="p-5">
          {single ? (
            <>
              <p className="mb-2">
                Archive worktree <strong>{worktrees[0].path?.split('/').pop()}</strong>.
              </p>
              <p className="text-sm text-base-content/60 mb-2">
                Branch: <strong>{formatBranchName(worktrees[0].branch)}</strong>
              </p>
            </>
          ) : (
            <div className="mb-4">
              <p className="mb-2">Archive the following worktrees:</p>
              <ul className="list-disc list-inside text-sm space-y-1">
                {worktrees.map(w => (
                  <li key={w.path}>
                    <strong>{formatBranchName(w.branch)}</strong>
                    <span className="text-base-content/50 ml-1">({w.path?.split('/').pop()})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-base-content/60 mb-4">
            This will remove the working {single ? 'directory' : 'directories'} but keep the {single ? 'branch' : 'branches'} in git.
          </p>

          {anyLoading ? (
            <p className="text-base-content/60 italic">Loading worktree status...</p>
          ) : anyDirty ? (
            <div className="mt-4">
              <h4 className="text-sm font-semibold mb-3 text-warning">Uncommitted Changes</h4>
              <div className="bg-base-100 rounded p-3 mb-4 space-y-2">
                {worktreeStates.filter(s => s.status && (s.status.hasChanges || s.status.hasStaged)).map(s => (
                  <div key={s.worktree.path}>
                    {!single && (
                      <p className="text-xs font-semibold mb-1">{formatBranchName(s.worktree.branch)}</p>
                    )}
                    <div className="flex flex-wrap gap-x-3">
                      {s.status!.staged.length > 0 && (
                        <span className="text-xs text-success">Staged: {s.status!.staged.length}</span>
                      )}
                      {s.status!.modified.length > 0 && (
                        <span className="text-xs text-warning">Modified: {s.status!.modified.length}</span>
                      )}
                      {s.status!.not_added.length > 0 && (
                        <span className="text-xs text-base-content/60">Untracked: {s.status!.not_added.length}</span>
                      )}
                      {s.status!.deleted.length > 0 && (
                        <span className="text-xs text-error">Deleted: {s.status!.deleted.length}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mb-4">
                <label className="block mb-2 text-sm font-medium">How would you like to handle these changes?</label>
                <div className="flex flex-col gap-2 mt-2">
                  {[
                    { value: 'commit' as const, label: 'Commit', hint: 'Create a new commit with these changes', hintClass: 'text-base-content/60' },
                    { value: 'amend' as const, label: 'Amend', hint: 'Add changes to the last commit', hintClass: 'text-base-content/60' },
                    { value: 'stash' as const, label: 'Stash', hint: 'Save changes to stash for later', hintClass: 'text-base-content/60' },
                    { value: 'clean' as const, label: 'Discard', hint: 'Permanently delete all uncommitted changes', hintClass: 'text-error' },
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
                        onChange={() => setChangeHandling(opt.value)}
                        disabled={isArchiving}
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
                    <label className="block mb-2 text-sm font-medium" htmlFor="archive-commit-message">Commit Message</label>
                    <input
                      id="archive-commit-message"
                      type="text"
                      className="input input-bordered w-full"
                      value={commitMessage}
                      onChange={e => setCommitMessage(e.target.value)}
                      placeholder="wip changes"
                      disabled={isArchiving}
                    />
                  </div>
                )}

                {(changeHandling === 'commit' || changeHandling === 'amend') && (
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={noVerify}
                      onChange={e => setNoVerify(e.target.checked)}
                      disabled={isArchiving}
                    />
                    <span className="text-sm">Skip git hooks (--no-verify)</span>
                  </label>
                )}
              </div>
            </div>
          ) : (
            <p className="text-success">{single ? 'Worktree is clean.' : 'All worktrees are clean.'} Ready to archive.</p>
          )}

          {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-base-300">
          <button
            type="button"
            className="btn btn-outline btn-neutral"
            onClick={onClose}
            disabled={isArchiving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-warning"
            onClick={handleArchive}
            disabled={anyLoading || isArchiving || (changeHandling === 'commit' && anyDirty && !commitMessage.trim())}
          >
            {isArchiving ? 'Archiving...' : `Archive ${single ? '' : `${worktrees.length} `}Worktree${single ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ArchiveWorktreeModal
