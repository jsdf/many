import React, { useState, useEffect } from 'react'
import { Repository, Worktree } from './types'
import Sidebar from './components/Sidebar'
import MainContent from './components/MainContent'
import CreateWorktreeModal from './components/CreateWorktreeModal'
import AddRepoModal from './components/AddRepoModal'

const App: React.FC = () => {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [currentRepo, setCurrentRepo] = useState<string | null>(null)
  const [currentUsername, setCurrentUsername] = useState<string>('user')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showAddRepoModal, setShowAddRepoModal] = useState(false)

  useEffect(() => {
    loadSavedRepos()
    restoreSelectedRepo()
  }, [])

  const loadSavedRepos = async () => {
    try {
      const repos = await window.electronAPI.getSavedRepos()
      setRepositories(repos)
    } catch (error) {
      console.error('Failed to load saved repos:', error)
    }
  }

  const restoreSelectedRepo = async () => {
    try {
      const selectedRepo = await window.electronAPI.getSelectedRepo()
      if (selectedRepo) {
        setCurrentRepo(selectedRepo)
        await selectRepo(selectedRepo)
      }
    } catch (error) {
      console.error('Failed to restore selected repo:', error)
    }
  }

  const selectRepo = async (repoPath: string | null) => {
    if (!repoPath) {
      setCurrentRepo(null)
      setWorktrees([])
      await window.electronAPI.setSelectedRepo(null)
      return
    }

    setCurrentRepo(repoPath)

    try {
      await window.electronAPI.setSelectedRepo(repoPath)
      const username = await window.electronAPI.getGitUsername(repoPath)
      setCurrentUsername(username)
      const repoWorktrees = await window.electronAPI.getWorktrees(repoPath)
      setWorktrees(repoWorktrees)
    } catch (error) {
      console.error('Failed to load repo data:', error)
      alert('Failed to load repository data. Please check the path.')
    }
  }

  const addRepository = async (repoPath: string) => {
    try {
      await window.electronAPI.saveRepo(repoPath)
      await loadSavedRepos()
      setShowAddRepoModal(false)
      setCurrentRepo(repoPath)
      await selectRepo(repoPath)
    } catch (error) {
      console.error('Failed to add repository:', error)
      throw new Error('Failed to add repository. Please check the path.')
    }
  }

  const createWorktree = async (branchName: string) => {
    if (!currentRepo) {
      throw new Error('Please select a repository first')
    }

    try {
      const result = await window.electronAPI.createWorktree(currentRepo, branchName)
      console.log('Created worktree:', result)
      
      // Refresh the worktree list
      const updatedWorktrees = await window.electronAPI.getWorktrees(currentRepo)
      setWorktrees(updatedWorktrees)
      setShowCreateModal(false)
    } catch (error) {
      console.error('Failed to create worktree:', error)
      throw error
    }
  }

  return (
    <div className="app">
      <Sidebar
        repositories={repositories}
        currentRepo={currentRepo}
        worktrees={worktrees}
        selectedWorktree={selectedWorktree}
        onRepoSelect={selectRepo}
        onWorktreeSelect={setSelectedWorktree}
        onAddRepo={() => setShowAddRepoModal(true)}
        onCreateWorktree={() => setShowCreateModal(true)}
      />
      
      <MainContent selectedWorktree={selectedWorktree} />

      {showCreateModal && (
        <CreateWorktreeModal
          onClose={() => setShowCreateModal(false)}
          onCreate={createWorktree}
        />
      )}

      {showAddRepoModal && (
        <AddRepoModal
          onClose={() => setShowAddRepoModal(false)}
          onAdd={addRepository}
        />
      )}
    </div>
  )
}

export default App