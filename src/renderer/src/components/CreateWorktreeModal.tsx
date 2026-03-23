import React, { useState, useEffect, useRef } from 'react'
import { PoolConfig } from '../types'
import { client } from '../main'

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

const token = new URLSearchParams(window.location.search).get('token') ?? ''

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
          client.getBranches.query({ repoPath: currentRepo }),
          client.getRepoConfig.query({ repoPath: currentRepo })
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

  const runInitStream = async (worktreePath: string, initCommand: string) => {
    setLog([])
    setDone(false)
    setLog(prev => [...prev, { type: 'step', text: `Running init command: ${initCommand}` }])

    try {
      const response = await fetch(`${window.location.origin}/api/run-init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-token': token,
        },
        body: JSON.stringify({ worktreePath, initCommand }),
      })

      if (!response.ok || !response.body) {
        throw new Error(`Init request failed: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              if (event.type === 'stdout' || event.type === 'stderr') {
                setLog(prev => [...prev, { type: event.type, text: event.text }])
              } else if (event.type === 'done') {
                setDone(true)
                if (event.code === 0) {
                  setLog(prev => [...prev, { type: 'step', text: 'Init command completed' }])
                } else {
                  setLog(prev => [...prev, { type: 'error', text: `Init command failed with exit code ${event.code}` }])
                }
              } else if (event.type === 'error') {
                setLog(prev => [...prev, { type: 'error', text: event.message }])
                setDone(true)
              }
            } catch {
              // Skip malformed event
            }
          }
        }
      }
    } catch (err) {
      setLog(prev => [...prev, { type: 'error', text: err instanceof Error ? err.message : 'Unknown error' }])
      setDone(true)
    }
  }

  const handleStreamingCreate = async (body: object) => {
    setIsCreating(true)
    setError(null)
    setLog([])
    setDone(false)

    try {
      const response = await fetch(`${window.location.origin}/api/create-worktree`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-token': token,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              if (event.type === 'step' || event.type === 'stdout' || event.type === 'stderr') {
                setLog(prev => [...prev, { type: event.type, text: event.text }])
              } else if (event.type === 'error') {
                setLog(prev => [...prev, { type: 'error', text: event.text }])
                setError(event.text)
              } else if (event.type === 'done') {
                setDone(true)
                if (event.success && event.worktreePath) {
                  onCreated(event.worktreePath)
                }
              }
            } catch {
              // Skip malformed event
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create worktree')
    } finally {
      setIsCreating(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (activeTab === 'free') {
      if (!worktreeName.trim()) {
        setError('Please enter a worktree name')
        return
      }
      await handleStreamingCreate({
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
          await runInitStream(result.path, result.initCommand)
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
          await runInitStream(result.path, result.initCommand)
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
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose} disabled={isCreating}>&times;</button>
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
                  className="btn btn-neutral"
                  onClick={onClose}
                  disabled={isCreating}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="create-worktree-submit"
                  className="btn btn-primary"
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
                className="btn btn-primary"
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
