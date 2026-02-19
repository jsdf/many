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

  // Auto-scroll init output
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

        // Parse SSE events from buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

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

      // If there's an init command, stream its output
      if (result.initCommand) {
        await runInitStream(result.path, result.initCommand)
      } else {
        // No init command, close immediately
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

  // After creation + init, show the output area instead of the form
  const showInitOutput = initRunning || initDone

  return (
    <div className="modal show" onClick={handleBackdropClick}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>Create New Worktree</h3>
          <button className="modal-close" onClick={onClose} disabled={initRunning}>&times;</button>
        </div>

        {!showInitOutput && (
          <>
            <div className="modal-tabs">
              <button
                className={`modal-tab${activeTab === 'free' ? ' active' : ''}`}
                onClick={() => setActiveTab('free')}
                type="button"
              >
                Free Worktree
              </button>
              <button
                className={`modal-tab${activeTab === 'newBranch' ? ' active' : ''}`}
                onClick={() => setActiveTab('newBranch')}
                type="button"
              >
                New Branch
              </button>
              <button
                className={`modal-tab${activeTab === 'existingBranch' ? ' active' : ''}`}
                onClick={() => setActiveTab('existingBranch')}
                type="button"
              >
                Existing Branch
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {activeTab === 'free' && (
                  <div className="form-group">
                    <label htmlFor="worktree-name-input">Worktree name:</label>
                    <input
                      type="text"
                      id="worktree-name-input"
                      data-testid="worktree-name-input"
                      value={worktreeName}
                      onChange={(e) => setWorktreeName(e.target.value)}
                      placeholder="e.g., feature-1, experiment, task-42..."
                      autoFocus
                      disabled={isCreating}
                    />
                    <p className="form-hint">Creates a pool worktree on a temporary branch, ready to be claimed later.</p>
                  </div>
                )}

                {activeTab === 'newBranch' && (
                  <>
                    <div className="form-group">
                      <label htmlFor="branch-input">New branch name:</label>
                      <input
                        type="text"
                        id="branch-input"
                        data-testid="branch-name-input"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        placeholder="e.g., username/feature-name, fix-bug, add-feature..."
                        autoFocus
                        disabled={isCreating}
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="base-branch-select">Base branch:</label>
                      <select
                        id="base-branch-select"
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
                  <div className="form-group">
                    <label htmlFor="existing-branch-select">Select existing branch:</label>
                    <select
                      id="existing-branch-select"
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

                {error && <p className="error-message">{error}</p>}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  data-testid="create-worktree-cancel"
                  className="btn btn-secondary"
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
            <div className="modal-body">
              <p style={{ marginBottom: 12, color: '#cccccc' }}>
                Running init command...
              </p>
              <div className="init-output" ref={outputRef}>
                {initOutput.map((line, i) => (
                  <span key={i} className={line.type === 'stderr' ? 'stderr' : undefined}>
                    {line.text}
                  </span>
                ))}
                {initDone && (
                  <div className={initExitCode === 0 ? 'init-done' : 'init-error'}>
                    {initExitCode === 0
                      ? '\nInit command completed successfully.'
                      : `\nInit command failed with exit code ${initExitCode}.`}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
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
