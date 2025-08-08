import React, { useState, useEffect } from "react";
import { Repository, Worktree, RepositoryConfig, MergeOptions } from "./types";
import Sidebar from "./components/Sidebar";
import MainContent from "./components/MainContent";
// import { cleanupWorktreeState } from "./hooks/useWorktreeTerminals";
import CreateWorktreeModal from "./components/CreateWorktreeModal";
import AddRepoModal from "./components/AddRepoModal";
import MergeWorktreeModal from "./components/MergeWorktreeModal";
import RebaseWorktreeModal from "./components/RebaseWorktreeModal";
import { client } from "./main";
import { logError } from "./logger";

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
  const [trpcMessage, setTrpcMessage] = useState<string>("");

  useEffect(() => {
    loadSavedRepos();
    restoreSelectedRepo();
    
    // Auto-test tRPC after 3 seconds for verification
    setTimeout(() => {
      console.log("Auto-testing tRPC...");
      testTrpc();
    }, 3000);
  }, []);

  const loadSavedRepos = async () => {
    try {
      const repos = await window.electronAPI.getSavedRepos();
      setRepositories(repos);
    } catch (error) {
      console.error("Failed to load saved repos:", error);
    }
  };

  const restoreSelectedRepo = async () => {
    try {
      const selectedRepo = await window.electronAPI.getSelectedRepo();
      if (selectedRepo) {
        setCurrentRepo(selectedRepo);
        await selectRepo(selectedRepo);
      }
    } catch (error) {
      console.error("Failed to restore selected repo:", error);
    }
  };

  const testTrpc = async () => {
    console.warn("=== tRPC Test Button Clicked ===");
    setTrpcMessage("Testing...");
    
    // Check if electronTRPC global is available
    console.warn("electronTRPC global check:", typeof (window as any).electronTRPC);
    if ((window as any).electronTRPC) {
      console.warn("electronTRPC methods:", Object.keys((window as any).electronTRPC));
    }
    
    try {
      console.warn("Starting tRPC test...");
      const result = await client.hello.query({ name: "tRPC" });
      console.warn("tRPC result:", result);
      setTrpcMessage(`Success: ${result}`);
      
      // Test client-side logging
      await logError("Test client-side logging functionality", "TRPC_TEST");
    } catch (error) {
      console.error("tRPC test failed:", error);
      setTrpcMessage(`tRPC test failed: ${error instanceof Error ? error.message : String(error)}`);
      
      // Log error to main process
      await logError(error, "TRPC_ERROR");
    }
  };

  const selectRepo = async (repoPath: string | null) => {
    if (!repoPath) {
      setCurrentRepo(null);
      setWorktrees([]);
      setSelectedWorktree(null);
      await window.electronAPI.setSelectedRepo(null);
      return;
    }

    setCurrentRepo(repoPath);

    try {
      await window.electronAPI.setSelectedRepo(repoPath);
      const repoWorktrees = await window.electronAPI.getWorktrees(repoPath);
      setWorktrees(repoWorktrees);

      // Auto-select the most recent worktree or default to main/base branch
      if (repoWorktrees.length > 0) {
        let worktreeToSelect: Worktree | null = null;

        // First, try to get the most recently used worktree
        const recentWorktreePath = await window.electronAPI.getRecentWorktree(
          repoPath
        );
        if (recentWorktreePath) {
          worktreeToSelect =
            repoWorktrees.find((wt) => wt.path === recentWorktreePath) || null;
        }

        // If no recent worktree or it no longer exists, select the base/main worktree
        if (!worktreeToSelect) {
          worktreeToSelect =
            repoWorktrees.find(
              (wt) =>
                wt.branch === "main" ||
                wt.branch === "master" ||
                wt.path.endsWith(repoPath) // This is typically the base worktree
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
      await window.electronAPI.saveRepo(repoPath);
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
      const result = await window.electronAPI.createWorktree(
        currentRepo,
        branchName,
        baseBranch
      );
      console.log("Created worktree:", result);

      // Refresh the worktree list
      const updatedWorktrees = await window.electronAPI.getWorktrees(
        currentRepo
      );
      setWorktrees(updatedWorktrees);

      // Find the newly created worktree and select it
      const newWorktree = updatedWorktrees.find(
        (wt) => wt.path === result.path
      );
      if (newWorktree) {
        await handleWorktreeSelect(newWorktree);
      }

      setShowCreateModal(false);

      // Setup terminal is now created atomically in the backend during worktree creation
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
      await window.electronAPI.saveRepoConfig(currentRepo, config);
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
        await window.electronAPI.setRecentWorktree(currentRepo, worktree.path);
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
      // Clean up terminals associated with this worktree
      await window.electronAPI.cleanupWorktreeTerminals(worktree.path);

      // Clean up frontend terminal state
      // cleanupWorktreeState(worktree.path);

      // Archive the worktree
      await window.electronAPI.archiveWorktree(currentRepo, worktree.path, force);

      // Refresh the worktree list
      if (currentRepo) {
        const updatedWorktrees = await window.electronAPI.getWorktrees(
          currentRepo
        );
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
      await window.electronAPI.mergeWorktree(
        currentRepo,
        worktreeToMerge.branch!,
        toBranch,
        options
      );

      // Refresh the worktree list
      const updatedWorktrees = await window.electronAPI.getWorktrees(
        currentRepo
      );
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
      await window.electronAPI.rebaseWorktree(
        worktreeToRebase.path,
        worktreeToRebase.branch!,
        ontoBranch
      );

      setShowRebaseModal(false);
      setWorktreeToRebase(null);
    } catch (error) {
      console.error("Failed to rebase worktree:", error);
      throw error;
    }
  };

  return (
    <div className="app">
      {/* tRPC Test Button - Remove after testing */}
      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 1000 }}>
        <button onClick={testTrpc} style={{ marginRight: '10px' }}>
          Test tRPC
        </button>
        {trpcMessage && <span style={{ color: 'green' }}>{trpcMessage}</span>}
      </div>
      
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
      />

      <MainContent
        selectedWorktree={selectedWorktree}
        currentRepo={currentRepo}
        onArchiveWorktree={archiveWorktree}
        onMergeWorktree={openMergeModal}
        onRebaseWorktree={openRebaseModal}
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

      {showMergeModal && worktreeToMerge && (
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

      {showRebaseModal && worktreeToRebase && (
        <RebaseWorktreeModal
          currentRepo={currentRepo}
          fromBranch={worktreeToRebase.branch!}
          worktreePath={worktreeToRebase.path}
          onClose={() => {
            setShowRebaseModal(false);
            setWorktreeToRebase(null);
          }}
          onRebase={rebaseWorktree}
        />
      )}
    </div>
  );
};

export default App;
