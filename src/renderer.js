class WorktreeManager {
    constructor() {
        this.currentRepo = null;
        this.currentUsername = 'user';
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.loadSavedRepos();
        await this.restoreSelectedRepo();
    }

    setupEventListeners() {
        // Repo selection
        document.getElementById('repo-select').addEventListener('change', (e) => {
            this.selectRepo(e.target.value);
        });

        // Add repo button
        document.getElementById('add-repo-btn').addEventListener('click', () => {
            this.showAddRepoModal();
        });

        // Create worktree button
        document.getElementById('create-worktree-btn').addEventListener('click', () => {
            this.showCreateWorktreeModal();
        });

        // Create worktree modal
        document.getElementById('modal-close').addEventListener('click', () => {
            this.hideCreateWorktreeModal();
        });
        document.getElementById('modal-cancel').addEventListener('click', () => {
            this.hideCreateWorktreeModal();
        });
        document.getElementById('modal-create').addEventListener('click', () => {
            this.createWorktree();
        });

        // Add repo modal
        document.getElementById('add-repo-modal-close').addEventListener('click', () => {
            this.hideAddRepoModal();
        });
        document.getElementById('add-repo-cancel').addEventListener('click', () => {
            this.hideAddRepoModal();
        });
        document.getElementById('add-repo-save').addEventListener('click', () => {
            this.addRepository();
        });

        // Browse folder button
        document.getElementById('browse-folder-btn').addEventListener('click', () => {
            this.browseForFolder();
        });


        // Close modals on outside click
        document.getElementById('create-modal').addEventListener('click', (e) => {
            if (e.target.id === 'create-modal') {
                this.hideCreateWorktreeModal();
            }
        });
        document.getElementById('add-repo-modal').addEventListener('click', (e) => {
            if (e.target.id === 'add-repo-modal') {
                this.hideAddRepoModal();
            }
        });
    }

    async loadSavedRepos() {
        try {
            const repos = await window.electronAPI.getSavedRepos();
            this.updateRepoSelect(repos);
        } catch (error) {
            console.error('Failed to load saved repos:', error);
        }
    }

    updateRepoSelect(repos) {
        const select = document.getElementById('repo-select');
        select.innerHTML = '<option value="">Select a repository...</option>';
        
        repos.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.path;
            option.textContent = repo.name || repo.path;
            select.appendChild(option);
        });
    }

    async selectRepo(repoPath) {
        if (!repoPath) {
            this.currentRepo = null;
            this.updateWorktreeList([]);
            document.getElementById('create-worktree-btn').disabled = true;
            // Save empty selection
            await window.electronAPI.setSelectedRepo(null);
            return;
        }

        this.currentRepo = repoPath;
        document.getElementById('create-worktree-btn').disabled = false;
        
        try {
            // Save selected repo
            await window.electronAPI.setSelectedRepo(repoPath);
            
            // Get username for this repo
            this.currentUsername = await window.electronAPI.getGitUsername(repoPath);
            
            // Load worktrees
            const worktrees = await window.electronAPI.getWorktrees(repoPath);
            this.updateWorktreeList(worktrees);
        } catch (error) {
            console.error('Failed to load repo data:', error);
            this.showError('Failed to load repository data. Please check the path.');
        }
    }

    updateWorktreeList(worktrees) {
        const listEl = document.getElementById('worktree-list');
        
        if (worktrees.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No worktrees found</p>';
            return;
        }

        listEl.innerHTML = '';
        
        worktrees.forEach(worktree => {
            const item = document.createElement('div');
            item.className = 'worktree-item';
            
            const pathEl = document.createElement('div');
            pathEl.className = 'worktree-path';
            pathEl.textContent = worktree.path;
            
            const branchEl = document.createElement('div');
            branchEl.className = 'worktree-branch';
            branchEl.textContent = worktree.branch || 'detached HEAD';
            
            item.appendChild(pathEl);
            item.appendChild(branchEl);
            
            item.addEventListener('click', () => {
                this.selectWorktree(worktree);
            });
            
            listEl.appendChild(item);
        });
    }

    selectWorktree(worktree) {
        // Remove active class from all items
        document.querySelectorAll('.worktree-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Add active class to clicked item
        event.currentTarget.classList.add('active');
        
        // TODO: Update main content area with worktree details
    }

    showAddRepoModal() {
        document.getElementById('add-repo-modal').classList.add('show');
        document.getElementById('repo-path-input').focus();
    }

    hideAddRepoModal() {
        document.getElementById('add-repo-modal').classList.remove('show');
        document.getElementById('repo-path-input').value = '';
    }

    async addRepository() {
        const repoPath = document.getElementById('repo-path-input').value.trim();
        
        if (!repoPath) {
            this.showError('Please enter a repository path');
            return;
        }

        try {
            await window.electronAPI.saveRepo(repoPath);
            await this.loadSavedRepos();
            this.hideAddRepoModal();
            
            // Select the newly added repo
            document.getElementById('repo-select').value = repoPath;
            await this.selectRepo(repoPath);
        } catch (error) {
            console.error('Failed to add repository:', error);
            this.showError('Failed to add repository. Please check the path.');
        }
    }

    showCreateWorktreeModal() {
        if (!this.currentRepo) {
            this.showError('Please select a repository first');
            return;
        }
        
        document.getElementById('create-modal').classList.add('show');
        document.getElementById('branch-input').focus();
    }

    hideCreateWorktreeModal() {
        document.getElementById('create-modal').classList.remove('show');
        document.getElementById('branch-input').value = '';
    }

    async createWorktree() {
        const branchName = document.getElementById('branch-input').value.trim();
        
        if (!branchName) {
            this.showError('Please enter a branch name');
            return;
        }

        if (!this.currentRepo) {
            this.showError('Please select a repository first');
            return;
        }

        try {
            const result = await window.electronAPI.createWorktree(this.currentRepo, branchName);
            console.log('Created worktree:', result);
            
            // Refresh the worktree list
            const worktrees = await window.electronAPI.getWorktrees(this.currentRepo);
            this.updateWorktreeList(worktrees);
            
            this.hideCreateWorktreeModal();
            this.showSuccess(`Created worktree at ${result.path}`);
        } catch (error) {
            console.error('Failed to create worktree:', error);
            this.showError(`Failed to create worktree: ${error.message}`);
        }
    }

    showError(message) {
        // Simple error display - could be enhanced with a proper notification system
        alert(`Error: ${message}`);
    }

    showSuccess(message) {
        // Simple success display - could be enhanced with a proper notification system
        alert(`Success: ${message}`);
    }

    async browseForFolder() {
        try {
            const folderPath = await window.electronAPI.selectFolder();
            if (folderPath) {
                document.getElementById('repo-path-input').value = folderPath;
            }
        } catch (error) {
            console.error('Failed to select folder:', error);
            this.showError('Failed to open folder picker');
        }
    }

    async restoreSelectedRepo() {
        try {
            const selectedRepo = await window.electronAPI.getSelectedRepo();
            if (selectedRepo) {
                // Set the dropdown value
                document.getElementById('repo-select').value = selectedRepo;
                // Load the repository
                await this.selectRepo(selectedRepo);
            }
        } catch (error) {
            console.error('Failed to restore selected repo:', error);
        }
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new WorktreeManager();
});