import React, { useState, useEffect, useRef } from 'react'
import { client } from '../main'

type TabId = 'free' | 'newBranch' | 'existingBranch'

interface CreateResult {
  path: string
  branch: string
  initCommand: string | null
}

interface CreateWorktreeModalProps {
  currentRepo: string | null
  onClose: () => void
  onCreate: (branchName: string, baseBranch: string) => Promise<CreateResult>
  onCreatePool: (worktreeName: string) => Promise<CreateResult>
}

const token = new URLSearchParams(window.location.search).get('token') ?? ''

const CreateWorktreeModal: React.FC<CreateWorktreeModalProps> = ({ currentRepo, onClose, onCreate, onCreatePool }) => {
  const [activeTab, setActiveTab] = useState<TabId>('free')
  const [worktreeName, setWorktreeName] = useState('')
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [selectedExistingBranch, setSelectedExistingBranch] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initOutput, setInitOutput] = useState<Array<{ type: 'stdout' | 'stderr'; text: string }>>([])
  const [initRunning, setInitRunning] = useState(false)
  const [initDone, setInitDone] = useState(false)
  const [initExitCode, setInitExitCode] = useState<number | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const defaultBranches = ['main', 'master', 'dev', 'develop', 'trunk']

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !initRunning) {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, initRunning])

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
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [initOutput])

  const runInitStream = async (worktreePath: string, initCommand: string) => {
    setInitRunning(true)
    setInitOutput([])
    setInitDone(false)
    setInitExitCode(null)

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
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6))
              if (event.type === 'stdout' || event.type === 'stderr') {
                setInitOutput(prev => [...prev, { type: event.type, text: event.text }])
              } else if (event.type === 'done') {
                setInitExitCode(event.code)
                setInitDone(true)
              } else if (event.type === 'error') {
                setInitOutput(prev => [...prev, { type: 'stderr', text: event.message }])
                setInitDone(true)
                setInitExitCode(1)
              }
            } catch {
              // Skip malformed event
            }
          }
        }
      }
    } catch (err) {
      setInitOutput(prev => [...prev, { type: 'stderr', text: err instanceof Error ? err.message : 'Unknown error' }])
      setInitDone(true)
      setInitExitCode(1)
    } finally {
      setInitRunning(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsCreating(true)
    setError(null)

    try {
      let result: CreateResult

      if (activeTab === 'free') {
        if (!worktreeName.trim()) {
          setError('Please enter a worktree name')
          setIsCreating(false)
          return
        }
        result = await onCreatePool(worktreeName.trim())
      } else if (activeTab === 'newBranch') {
        if (!branchName.trim()) {
          setError('Please enter a branch name')
          setIsCreating(false)
          return
        }
        if (!baseBranch) {
          setError('Please select a base branch')
          setIsCreating(false)
          return
        }
        result = await onCreate(branchName.trim(), baseBranch)
      } else {
        if (!selectedExistingBranch) {
          setError('Please select a branch')
          setIsCreating(false)
          return
        }
        result = await onCreate(selectedExistingBranch, selectedExistingBranch)
      }

      setIsCreating(false)

      if (result.initCommand) {
        await runInitStream(result.path, result.initCommand)
      } else {
        onClose()
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create worktree')
      setIsCreating(false)
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !initRunning) {
      onClose()
    }
  }

  const showInitOutput = initRunning || initDone

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Create New Worktree</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose} disabled={initRunning}>&times;</button>
        </div>

        {!showInitOutput && (
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

                {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
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
                  disabled={isCreating || isLoadingBranches || (
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

        {showInitOutput && (
          <>
            <div className="p-5">
              <p className="mb-3 text-base-content/80">
                Running init command...
              </p>
              <div
                className="bg-base-100 border border-base-300 rounded p-3 max-h-[300px] overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-base-content/80"
                ref={outputRef}
              >
                {initOutput.map((line, i) => (
                  <span key={i} className={line.type === 'stderr' ? 'text-warning' : undefined}>
                    {line.text}
                  </span>
                ))}
                {initDone && (
                  <div className={`mt-2 ${initExitCode === 0 ? 'text-success' : 'text-error'}`}>
                    {initExitCode === 0
                      ? '\nInit command completed successfully.'
                      : `\nInit command failed with exit code ${initExitCode}.`}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-base-300">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onClose}
                disabled={initRunning}
              >
                {initRunning ? 'Running...' : 'Close'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default CreateWorktreeModal
