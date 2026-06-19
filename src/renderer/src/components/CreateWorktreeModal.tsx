import React, { useState, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { PoolConfig } from '../types'
import { getRpcClient } from '../rpc-client'
import type { StreamEvent } from '../../../shared/protocol'

type TabId = 'free' | 'newBranch' | 'existingBranch'

type LogEntry = { type: 'step' | 'stdout' | 'stderr' | 'error'; text: string }

interface CreateResult {
  path: string
  branch: string
  initCommand: string | null
}

interface CreateWorktreeModalProps {
  currentRepo: string | null
  pools?: PoolConfig[]
  onClose: () => void
  onCreate: (branchName: string, baseBranch: string) => Promise<CreateResult>
  onCreated: (worktreePath: string) => void
}

const CreateWorktreeModal: React.FC<CreateWorktreeModalProps> = ({ currentRepo, pools, onClose, onCreate, onCreated }) => {
  const [activeTab, setActiveTab] = useState<TabId>('free')
  const [worktreeName, setWorktreeName] = useState('')
  const [startingPoint, setStartingPoint] = useState('')
  const [pullLatest, setPullLatest] = useState(true)
  const [selectedPoolIndex, setSelectedPoolIndex] = useState(-1)
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [selectedExistingBranch, setSelectedExistingBranch] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [done, setDone] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const defaultBranches = ['main', 'master', 'dev', 'develop', 'trunk']

  const poolList = pools || []
  const selectedPool = poolList[selectedPoolIndex]

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isCreating])

  useEffect(() => {
    const loadBranches = async () => {
      if (!currentRepo) return

      setIsLoadingBranches(true)
      try {
        const [repoBranches, repoConfig] = await Promise.all([
          getRpcClient().query("branch.list", { repoPath: currentRepo }),
          getRpcClient().query("repo.getConfig", { repoPath: currentRepo })
        ])
        setBranches(repoBranches)

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

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log])

  const runInitStream = (worktreePath: string, initCommand: string) => {
    setLog([])
    setDone(false)
    setLog(prev => [...prev, { type: 'step', text: `Running init command: ${initCommand}` }])

    const unsubscribe = getRpcClient().subscribe(
      "stream.runInit",
      (event: StreamEvent) => {
        if (event.type === 'stdout' || event.type === 'stderr') {
          setLog(prev => [...prev, { type: event.type, text: event.text }])
        } else if (event.type === 'done') {
          setDone(true)
          if (event.code === 0) {
            setLog(prev => [...prev, { type: 'step', text: 'Init command completed' }])
          } else {
            setLog(prev => [...prev, { type: 'error', text: `Init command failed with exit code ${event.code}` }])
          }
          unsubscribe()
        } else if (event.type === 'error') {
          setLog(prev => [...prev, { type: 'error', text: event.text }])
          setDone(true)
          unsubscribe()
        }
      },
      { worktreePath, initCommand }
    )

    return unsubscribe
  }

  const handleStreamingCreate = (body: {
    repoPath: string | null
    worktreeName: string
    startingPoint?: string
    poolPrefix?: string
    pullLatest?: boolean
  }) => {
    setIsCreating(true)
    setError(null)
    setLog([])
    setDone(false)

    const unsubscribe = getRpcClient().subscribe(
      "stream.createWorktree",
      (event: StreamEvent) => {
        if (event.type === 'step' || event.type === 'stdout' || event.type === 'stderr') {
          setLog(prev => [...prev, { type: event.type, text: event.text }])
        } else if (event.type === 'error') {
          setLog(prev => [...prev, { type: 'error', text: event.text }])
          setError(event.text)
        } else if (event.type === 'done') {
          setDone(true)
          setIsCreating(false)
          if (event.success && event.worktreePath) {
            onCreated(event.worktreePath)
          }
          unsubscribe()
        }
      },
      {
        repoPath: body.repoPath ?? '',
        worktreeName: body.worktreeName,
        startingPoint: body.startingPoint,
        poolPrefix: body.poolPrefix,
        pullLatest: body.pullLatest,
      }
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (activeTab === 'free') {
      if (!worktreeName.trim()) {
        setError('Please enter a worktree name')
        return
      }
      handleStreamingCreate({
        repoPath: currentRepo,
        worktreeName: worktreeName.trim(),
        startingPoint: startingPoint.trim() || undefined,
        poolPrefix: selectedPool?.prefix || undefined,
        pullLatest,
      })
    } else if (activeTab === 'newBranch') {
      if (!branchName.trim()) {
        setError('Please enter a branch name')
        return
      }
      if (!baseBranch) {
        setError('Please select a base branch')
        return
      }
      setIsCreating(true)
      try {
        const result = await onCreate(branchName.trim(), baseBranch)
        onCreated(result.path)
        if (result.initCommand) {
          runInitStream(result.path, result.initCommand)
        } else {
          onClose()
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create worktree')
      } finally {
        setIsCreating(false)
      }
    } else {
      if (!selectedExistingBranch) {
        setError('Please select a branch')
        return
      }
      setIsCreating(true)
      try {
        const result = await onCreate(selectedExistingBranch, selectedExistingBranch)
        onCreated(result.path)
        if (result.initCommand) {
          runInitStream(result.path, result.initCommand)
        } else {
          onClose()
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create worktree')
      } finally {
        setIsCreating(false)
      }
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isCreating) {
      onClose()
    }
  }

  const showLog = log.length > 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Create New Worktree</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose} disabled={isCreating}><X size={18} /></button>
        </div>

        {!showLog && (
          <>
            <div className="flex border-b border-base-300 px-5">
              <button
                className={`bg-transparent border-none border-b-2 text-sm px-4 py-2.5 cursor-pointer transition-colors ${activeTab === 'free' ? 'text-base-content border-b-primary' : 'text-base-content/60 border-b-transparent hover:text-base-content'}`}
                onClick={() => setActiveTab('free')}
                type="button"
              >
                Free Worktree
              </button>
              <button
                className={`bg-transparent border-none border-b-2 text-sm px-4 py-2.5 cursor-pointer transition-colors ${activeTab === 'newBranch' ? 'text-base-content border-b-primary' : 'text-base-content/60 border-b-transparent hover:text-base-content'}`}
                onClick={() => setActiveTab('newBranch')}
                type="button"
              >
                New Branch
              </button>
              <button
                className={`bg-transparent border-none border-b-2 text-sm px-4 py-2.5 cursor-pointer transition-colors ${activeTab === 'existingBranch' ? 'text-base-content border-b-primary' : 'text-base-content/60 border-b-transparent hover:text-base-content'}`}
                onClick={() => setActiveTab('existingBranch')}
                type="button"
              >
                Existing Branch
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="p-5">
                {activeTab === 'free' && (
                  <>
                    <div className="mb-5">
                      <label className="block mb-2 text-sm font-medium" htmlFor="worktree-name-input">Worktree name:</label>
                      <input
                        type="text"
                        id="worktree-name-input"
                        data-testid="worktree-name-input"
                        className="input input-bordered w-full"
                        value={worktreeName}
                        onChange={(e) => setWorktreeName(e.target.value)}
                        placeholder="e.g., feature-1, experiment, task-42..."
                        autoFocus
                        disabled={isCreating}
                      />
                      <p className="text-xs text-base-content/50 mt-1.5">Creates a pool worktree on a temporary branch, ready to be claimed later.</p>
                    </div>

                    {poolList.length > 0 && (
                      <div className="mb-5">
                        <label className="block mb-2 text-sm font-medium" htmlFor="pool-select">Pool (optional):</label>
                        <select
                          id="pool-select"
                          className="select select-bordered w-full"
                          value={selectedPoolIndex}
                          onChange={(e) => setSelectedPoolIndex(Number(e.target.value))}
                          disabled={isCreating}
                        >
                          <option value={-1}>No pool (default)</option>
                          {poolList.map((pool, i) => (
                            <option key={pool.prefix} value={i}>
                              {pool.name} ({pool.prefix})
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-base-content/50 mt-1.5">
                          {selectedPool
                            ? `Worktree name will be prefixed: ${selectedPool.prefix}-${worktreeName || '...'}`
                            : 'Worktree will be created without a pool prefix.'}
                        </p>
                      </div>
                    )}

                    <div className="mb-5">
                      <label className="block mb-2 text-sm font-medium" htmlFor="starting-point-input">Starting point (optional):</label>
                      <input
                        type="text"
                        id="starting-point-input"
                        className="input input-bordered w-full"
                        value={startingPoint}
                        onChange={(e) => setStartingPoint(e.target.value)}
                        placeholder="Branch name, PR #, GitHub PR URL, or Graphite PR URL"
                        disabled={isCreating}
                      />
                      <p className="text-xs text-base-content/50 mt-1.5">
                        If set, this branch will be fetched and checked out after creation.
                      </p>
                    </div>

                    <div className="mb-5">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm checkbox-primary"
                          checked={pullLatest}
                          onChange={(e) => setPullLatest(e.target.checked)}
                          disabled={isCreating}
                        />
                        <span className="text-sm">Pull latest from remote</span>
                      </label>
                    </div>
                  </>
                )}

                {activeTab === 'newBranch' && (
                  <>
                    <div className="mb-5">
                      <label className="block mb-2 text-sm font-medium" htmlFor="branch-input">New branch name:</label>
                      <input
                        type="text"
                        id="branch-input"
                        data-testid="branch-name-input"
                        className="input input-bordered w-full"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        placeholder="e.g., username/feature-name, fix-bug, add-feature..."
                        autoFocus
                        disabled={isCreating}
                      />
                    </div>

                    <div className="mb-5">
                      <label className="block mb-2 text-sm font-medium" htmlFor="base-branch-select">Base branch:</label>
                      <select
                        id="base-branch-select"
                        className="select select-bordered w-full"
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.target.value)}
                        disabled={isCreating || isLoadingBranches}
                      >
                        {isLoadingBranches ? (
                          <option value="">Loading branches...</option>
                        ) : (
                          branches.map(branch => (
                            <option key={branch} value={branch}>
                              {branch}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  </>
                )}

                {activeTab === 'existingBranch' && (
                  <div className="mb-5">
                    <label className="block mb-2 text-sm font-medium" htmlFor="existing-branch-select">Select existing branch:</label>
                    <select
                      id="existing-branch-select"
                      className="select select-bordered w-full"
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
                )}

                {error && !showLog && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
              </div>
              <div className="flex justify-end gap-3 p-5 border-t border-base-300">
                <button
                  type="button"
                  data-testid="create-worktree-cancel"
                  className="btn btn-outline btn-neutral"
                  onClick={onClose}
                  disabled={isCreating}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="create-worktree-submit"
                  className="btn btn-outline btn-primary"
                  disabled={isCreating || isLoadingBranches || done || (
                    activeTab === 'free' ? !worktreeName.trim() :
                    activeTab === 'newBranch' ? !branchName.trim() :
                    !selectedExistingBranch
                  )}
                >
                  {isCreating ? 'Creating...' : 'Create Worktree'}
                </button>
              </div>
            </form>
          </>
        )}

        {showLog && (
          <>
            <div className="p-5">
              <div
                ref={logRef}
                className="bg-base-300 rounded-lg p-3 max-h-[300px] overflow-y-auto font-mono text-xs leading-relaxed"
              >
                {log.map((entry, i) => (
                  <div
                    key={i}
                    className={
                      entry.type === 'error'
                        ? 'text-error'
                        : entry.type === 'stderr'
                          ? 'text-warning'
                          : entry.type === 'step'
                            ? 'text-info'
                            : 'text-base-content/70'
                    }
                  >
                    {entry.type === 'step' ? `\u2192 ${entry.text}` : entry.text}
                  </div>
                ))}
                {isCreating && (
                  <span className="loading loading-dots loading-xs text-base-content/50"></span>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-base-300">
              <button
                type="button"
                className="btn btn-outline btn-primary"
                onClick={onClose}
                disabled={isCreating}
              >
                {isCreating ? 'Running...' : 'Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default CreateWorktreeModal
