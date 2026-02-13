import React, { useState, useEffect } from "react";
import { Repository, Worktree, RepositoryConfig, MergeOptions } from "./types";
import Sidebar from "./components/Sidebar";
import MainContent from "./components/MainContent";
import CreateWorktreeModal from "./components/CreateWorktreeModal";
import AddRepoModal from "./components/AddRepoModal";
import MergeWorktreeModal from "./components/MergeWorktreeModal";
import RebaseWorktreeModal from "./components/RebaseWorktreeModal";
import SwitchWorktreeModal from "./components/SwitchWorktreeModal";
import ReleaseWorktreeModal from "./components/ReleaseWorktreeModal";
import { client } from "./main";

const App: React.FC = () => {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(
    null
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [showRepoConfigModal, setShowRepoConfigModal] = useState(false);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [worktreeToMerge, setWorktreeToMerge] = useState<Worktree | null>(null);
  const [showRebaseModal, setShowRebaseModal] = useState(false);
  const [worktreeToRebase, setWorktreeToRebase] = useState<Worktree | null>(
    null
  );
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [worktreeToRelease, setWorktreeToRelease] = useState<Worktree | null>(
    null
  );

  useEffect(() => {
    loadSavedRepos();
    restoreSelectedRepo();
  }, []);

  const loadSavedRepos = async () => {
    try {
      const repos = await client.getSavedRepos.query();
      setRepositories(repos);
    } catch (error) {
      console.error("Failed to load saved repos:", error);
    }
  };

  const restoreSelectedRepo = async () => {
    try {
      const selectedRepo = await client.getSelectedRepo.query();
      if (selectedRepo) {
        setCurrentRepo(selectedRepo);
        await selectRepo(selectedRepo);
      }
    } catch (error) {
      console.error("Failed to restore selected repo:", error);
    }
  };


  const selectRepo = async (repoPath: string | null) => {
    if (!repoPath) {
      setCurrentRepo(null);
      setWorktrees([]);
      setSelectedWorktree(null);
      await client.setSelectedRepo.mutate({ repoPath: null });
      return;
    }

    setCurrentRepo(repoPath);

    try {
      await client.setSelectedRepo.mutate({ repoPath });
      const repoWorktrees = await client.getWorktrees.query({ repoPath });
      setWorktrees(repoWorktrees);

      // Auto-select the most recent worktree or default to main/base branch
      if (repoWorktrees.length > 0) {
        let worktreeToSelect: Worktree | null = null;

        // First, try to get the most recently used worktree
        const recentWorktreePath = await client.getRecentWorktree.query({
          repoPath
        });
        if (recentWorktreePath) {
          worktreeToSelect =
            repoWorktrees.find((wt) => wt.path && wt.path === recentWorktreePath) || null;
        }

        // If no recent worktree or it no longer exists, select the base/main worktree
        if (!worktreeToSelect) {
          worktreeToSelect =
            repoWorktrees.find(
              (wt) =>
                wt.branch === "main" ||
                wt.branch === "master" ||
                (wt.path && wt.path.endsWith(repoPath)) // This is typically the base worktree
            ) || repoWorktrees[0]; // Fall back to first worktree
        }

        setSelectedWorktree(worktreeToSelect);
      } else {
        setSelectedWorktree(null);
      }
    } catch (error) {
      console.error("Failed to load repo data:", error);
      alert("Failed to load repository data. Please check the path.");
    }
  };

  const addRepository = async (repoPath: string) => {
    try {
      await client.saveRepo.mutate({ repoPath });
      await loadSavedRepos();
      setShowAddRepoModal(false);
      setCurrentRepo(repoPath);
      await selectRepo(repoPath);
    } catch (error) {
      console.error("Failed to add repository:", error);
      throw new Error("Failed to add repository. Please check the path.");
    }
  };

  const createWorktree = async (branchName: string, baseBranch: string) => {
    if (!currentRepo) {
      throw new Error("Please select a repository first");
    }

    try {
      const result = await client.createWorktree.mutate({
        repoPath: currentRepo,
        branchName,
        baseBranch
      });
      console.log("Created worktree:", result);

      // Refresh the worktree list
      const updatedWorktrees = await client.getWorktrees.query({
        repoPath: currentRepo
      });
      setWorktrees(updatedWorktrees);

      // Find the newly created worktree and select it
      const newWorktree = updatedWorktrees.find(
        (wt) => wt.path && wt.path === result.path
      );
      if (newWorktree) {
        await handleWorktreeSelect(newWorktree);
      }

      setShowCreateModal(false);

    } catch (error) {
      console.error("Failed to create worktree:", error);
      throw error;
    }
  };

  const saveRepoConfig = async (config: RepositoryConfig) => {
    if (!currentRepo) {
      throw new Error("No repository selected");
    }

    try {
      await client.saveRepoConfig.mutate({ repoPath: currentRepo, config });
      setShowRepoConfigModal(false);
    } catch (error) {
      console.error("Failed to save repo config:", error);
      throw error;
    }
  };

  const handleWorktreeSelect = async (worktree: Worktree | null) => {
    setSelectedWorktree(worktree);

    // Track the most recently selected worktree for this repo
    if (worktree && currentRepo) {
      try {
        if (worktree.path) {
          await client.setRecentWorktree.mutate({
            repoPath: currentRepo,
            worktreePath: worktree.path
          });
        }
      } catch (error) {
        console.error("Failed to save recent worktree:", error);
      }
    }
  };

  const archiveWorktree = async (worktree: Worktree) => {
    if (!currentRepo) {
      throw new Error("No repository selected");
    }

    const performArchive = async (force = false) => {
      if (worktree.path) {
        await client.archiveWorktree.mutate({
          repoPath: currentRepo,
          worktreePath: worktree.path,
          force
        });
      }

      // Refresh the worktree list
      if (currentRepo) {
        const updatedWorktrees = await client.getWorktrees.query({
          repoPath: currentRepo
        });
        setWorktrees(updatedWorktrees);

        // Clear selection if the archived worktree was selected
        if (selectedWorktree === worktree) {
          setSelectedWorktree(null);
        }
      }
    };

    const handleMergeError = async (error: any, errorPrefix: string) => {
      const branchInfo = error.message.replace(errorPrefix, "");
      const confirmed = confirm(
        `${branchInfo}\n\nAre you sure you want to archive this worktree anyway? The branch will be preserved in git.`
      );

      if (confirmed) {
        try {
          await performArchive(true);
        } catch (forceError) {
          console.error("Failed to force archive worktree:", forceError);
          throw forceError;
        }
      }
    };

    try {
      await performArchive();
    } catch (error: any) {
      console.error("Failed to archive worktree:", error);

      // Handle special merge check errors with user confirmation
      if (error?.message?.includes("UNMERGED_BRANCH:")) {
        await handleMergeError(error, "UNMERGED_BRANCH:");
      } else if (error?.message?.includes("MERGE_CHECK_FAILED:")) {
        await handleMergeError(error, "MERGE_CHECK_FAILED:");
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  };

  const openMergeModal = (worktree: Worktree) => {
    setWorktreeToMerge(worktree);
    setShowMergeModal(true);
  };

  const openRebaseModal = (worktree: Worktree) => {
    setWorktreeToRebase(worktree);
    setShowRebaseModal(true);
  };

  const mergeWorktree = async (toBranch: string, options: MergeOptions) => {
    if (!currentRepo || !worktreeToMerge) {
      throw new Error("No repository or worktree selected");
    }

    try {
      await client.mergeWorktree.mutate({
        repoPath: currentRepo,
        fromBranch: worktreeToMerge.branch!,
        toBranch,
        options
      });

      // Refresh the worktree list
      const updatedWorktrees = await client.getWorktrees.query({
        repoPath: currentRepo
      });
      setWorktrees(updatedWorktrees);

      setShowMergeModal(false);
      setWorktreeToMerge(null);
    } catch (error) {
      console.error("Failed to merge worktree:", error);
      throw error;
    }
  };

  const rebaseWorktree = async (ontoBranch: string) => {
    if (!currentRepo || !worktreeToRebase) {
      throw new Error("No repository or worktree selected");
    }

    try {
      if (worktreeToRebase.path) {
        await client.rebaseWorktree.mutate({
          worktreePath: worktreeToRebase.path,
          fromBranch: worktreeToRebase.branch!,
          ontoBranch
        });
      }

      setShowRebaseModal(false);
      setWorktreeToRebase(null);
    } catch (error) {
      console.error("Failed to rebase worktree:", error);
      throw error;
    }
  };

  // Pool management: Switch (claim) a worktree for a branch
  const switchWorktree = async (worktreePath: string, branchName: string) => {
    if (!currentRepo) {
      throw new Error("No repository selected");
    }

    try {
      await client.claimWorktree.mutate({
        repoPath: currentRepo,
        worktreePath,
        branchName
      });

      // Refresh the worktree list
      const updatedWorktrees = await client.getWorktrees.query({
        repoPath: currentRepo
      });
      setWorktrees(updatedWorktrees);

      // Select the switched worktree
      const switchedWorktree = updatedWorktrees.find(
        (wt) => wt.path === worktreePath
      );
      if (switchedWorktree) {
        await handleWorktreeSelect(switchedWorktree);
      }

      setShowSwitchModal(false);
    } catch (error) {
      console.error("Failed to switch worktree:", error);
      throw error;
    }
  };

  // Pool management: Release a worktree back to the pool
  const openReleaseModal = (worktree: Worktree) => {
    setWorktreeToRelease(worktree);
    setShowReleaseModal(true);
  };

  const handleReleaseComplete = async () => {
    if (!currentRepo) return;

    // Refresh the worktree list
    const updatedWorktrees = await client.getWorktrees.query({
      repoPath: currentRepo
    });
    setWorktrees(updatedWorktrees);

    // Update selection if the released worktree was selected
    if (worktreeToRelease && selectedWorktree?.path === worktreeToRelease.path) {
      const updatedWorktree = updatedWorktrees.find(
        (wt) => wt.path === worktreeToRelease.path
      );
      if (updatedWorktree) {
        setSelectedWorktree(updatedWorktree);
      }
    }

    setShowReleaseModal(false);
    setWorktreeToRelease(null);
  };

  return (
    <div className="app">
      
      <Sidebar
        repositories={repositories}
        currentRepo={currentRepo}
        worktrees={worktrees}
        selectedWorktree={selectedWorktree}
        onRepoSelect={selectRepo}
        onWorktreeSelect={handleWorktreeSelect}
        onAddRepo={() => setShowAddRepoModal(true)}
        onCreateWorktree={() => setShowCreateModal(true)}
        onConfigRepo={() => setShowRepoConfigModal(true)}
        onSwitchWorktree={() => setShowSwitchModal(true)}
      />

      <MainContent
        selectedWorktree={selectedWorktree}
        currentRepo={currentRepo}
        onArchiveWorktree={archiveWorktree}
        onMergeWorktree={openMergeModal}
        onRebaseWorktree={openRebaseModal}
        onReleaseWorktree={openReleaseModal}
      />

      {showCreateModal && (
        <CreateWorktreeModal
          currentRepo={currentRepo}
          onClose={() => setShowCreateModal(false)}
          onCreate={createWorktree}
        />
      )}

      {showAddRepoModal && (
        <AddRepoModal
          mode="add"
          onClose={() => setShowAddRepoModal(false)}
          onAdd={addRepository}
        />
      )}

      {showRepoConfigModal && (
        <AddRepoModal
          mode="config"
          currentRepo={currentRepo}
          onClose={() => setShowRepoConfigModal(false)}
          onSaveConfig={saveRepoConfig}
        />
      )}

      {showMergeModal && worktreeToMerge && worktreeToMerge.path && (
        <MergeWorktreeModal
          currentRepo={currentRepo}
          fromBranch={worktreeToMerge.branch!}
          worktreePath={worktreeToMerge.path}
          onClose={() => {
            setShowMergeModal(false);
            setWorktreeToMerge(null);
          }}
          onMerge={mergeWorktree}
        />
      )}

      {showRebaseModal && worktreeToRebase && worktreeToRebase.path && (
        <RebaseWorktreeModal
          currentRepo={currentRepo}
          fromBranch={worktreeToRebase.branch!}
          worktreePath={worktreeToRebase.path!}
          onClose={() => {
            setShowRebaseModal(false);
            setWorktreeToRebase(null);
          }}
          onRebase={rebaseWorktree}
        />
      )}

      {showSwitchModal && (
        <SwitchWorktreeModal
          currentRepo={currentRepo}
          worktrees={worktrees}
          onClose={() => setShowSwitchModal(false)}
          onSwitch={switchWorktree}
        />
      )}

      {showReleaseModal && worktreeToRelease && worktreeToRelease.path && (
        <ReleaseWorktreeModal
          currentRepo={currentRepo}
          worktree={worktreeToRelease}
          onClose={() => {
            setShowReleaseModal(false);
            setWorktreeToRelease(null);
          }}
          onRelease={handleReleaseComplete}
        />
      )}
    </div>
  );
};

export default App;
