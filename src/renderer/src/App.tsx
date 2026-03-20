import React, { useState, useEffect, useRef } from "react";
import { Repository, Worktree, RepositoryConfig, PoolConfig, MergeOptions, isTmpBranch } from "./types";
import Sidebar from "./components/Sidebar";
import MainContent, { MainContentHandle } from "./components/MainContent";
import NewTaskModal from "./components/NewTaskModal";
import CreateWorktreeModal from "./components/CreateWorktreeModal";
import AddRepoModal from "./components/AddRepoModal";
import MergeWorktreeModal from "./components/MergeWorktreeModal";
import RebaseWorktreeModal from "./components/RebaseWorktreeModal";
import SwitchWorktreeModal from "./components/SwitchWorktreeModal";
import ReleaseWorktreeModal from "./components/ReleaseWorktreeModal";
import GlobalSettingsModal from "./components/GlobalSettingsModal";
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
  const [showGlobalSettingsModal, setShowGlobalSettingsModal] = useState(false);
  const [repoConfig, setRepoConfig] = useState<RepositoryConfig | null>(null);
  const [claimPoolTarget, setClaimPoolTarget] = useState<PoolConfig | null>(null);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const mainContentRef = useRef<MainContentHandle>(null);

  useEffect(() => {
    loadSavedRepos();
    restoreSelectedRepo();
  }, []);

  useEffect(() => {
    const repo = repositories.find(r => r.path === currentRepo);
    document.title = repo
      ? `${repo.name || repo.path} - Many`
      : "Many - Worktree Manager";
  }, [currentRepo, repositories]);

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
      setRepoConfig(null);
      await client.setSelectedRepo.mutate({ repoPath: null });
      return;
    }

    setCurrentRepo(repoPath);

    try {
      await client.setSelectedRepo.mutate({ repoPath });
      const [repoWorktrees, config] = await Promise.all([
        client.getWorktrees.query({ repoPath }),
        client.getRepoConfig.query({ repoPath }),
      ]);
      setRepoConfig(config);
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

      // Don't close modal here - modal manages its own lifecycle for init streaming
      return result;
    } catch (error) {
      console.error("Failed to create worktree:", error);
      throw error;
    }
  };

  const createPoolWorktree = async (worktreeName: string) => {
    if (!currentRepo) {
      throw new Error("Please select a repository first");
    }

    try {
      const result = await client.createPoolWorktree.mutate({
        repoPath: currentRepo,
        worktreeName
      });
      console.log("Created pool worktree:", result);

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

      return result;
    } catch (error) {
      console.error("Failed to create pool worktree:", error);
      throw error;
    }
  };

  const saveRepoConfig = async (config: RepositoryConfig) => {
    if (!currentRepo) {
      throw new Error("No repository selected");
    }

    try {
      await client.saveRepoConfig.mutate({ repoPath: currentRepo, config });
      setRepoConfig(config);
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

    if (worktree.path) {
      await client.archiveWorktree.mutate({
        repoPath: currentRepo,
        worktreePath: worktree.path,
        force: true
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

      // If claiming from a pool with a maintenance command, run it
      const pool = claimPoolTarget;
      if (pool?.maintenanceCommand) {
        try {
          await client.runMaintenanceCommand.mutate({
            worktreePath,
            command: pool.maintenanceCommand,
          });
        } catch (err) {
          console.error("Maintenance command failed:", err);
          // Don't block the claim on maintenance failure
        }
      }

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
      setClaimPoolTarget(null);
    } catch (error) {
      console.error("Failed to switch worktree:", error);
      throw error;
    }
  };

  // Pool management: Claim a worktree from a specific pool
  const handleClaimPool = (pool: PoolConfig) => {
    setClaimPoolTarget(pool);
    setShowSwitchModal(true);
  };

  // Pool management: Release a worktree back to the pool
  const openReleaseModal = (worktree: Worktree) => {
    setWorktreeToRelease(worktree);
    setShowReleaseModal(true);
  };

  // Task launcher: claim/create worktree and launch command with prompt
  const handleLaunchTask = async (pool: PoolConfig, prompt: string, startingPoint?: string) => {
    if (!currentRepo) throw new Error("No repository selected");

    // Resolve starting point to a branch name if provided
    let resolvedBranch: string | undefined;
    if (startingPoint) {
      const result = await client.resolveStartingPoint.mutate({
        repoPath: currentRepo,
        startingPoint,
      });
      resolvedBranch = result.branchName;
    }

    let targetWorktreePath: string;

    if (pool.type === 'recyclable') {
      // Find first available worktree in this pool
      const available = worktrees.find(
        w => w.path !== currentRepo && !w.bare && isTmpBranch(w.branch) && w.worktreeName.startsWith(pool.prefix)
      );
      if (!available || !available.path) {
        throw new Error(`No available worktrees in pool "${pool.name}". Create more worktrees with prefix "${pool.prefix}".`);
      }

      // Use resolved branch from starting point, or generate from prompt
      const branchName = resolvedBranch
        ?? `task/${prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${Date.now().toString(36)}`;

      await client.claimWorktree.mutate({
        repoPath: currentRepo,
        worktreePath: available.path,
        branchName,
      });

      if (pool.maintenanceCommand) {
        try {
          await client.runMaintenanceCommand.mutate({
            worktreePath: available.path,
            command: pool.maintenanceCommand,
          });
        } catch (err) {
          console.error("Maintenance command failed:", err);
        }
      }

      targetWorktreePath = available.path;
    } else {
      // Ephemeral: create a new worktree
      const name = `${pool.prefix}-${Date.now().toString(36)}`;
      const result = await client.createPoolWorktree.mutate({
        repoPath: currentRepo,
        worktreeName: name,
      });
      targetWorktreePath = result.path;

      // If there's a starting point branch, check it out in the new worktree
      if (resolvedBranch) {
        await client.claimWorktree.mutate({
          repoPath: currentRepo,
          worktreePath: result.path,
          branchName: resolvedBranch,
        });
      }

      // Run the repo init command (e.g. npm install) if configured
      if (result.initCommand) {
        try {
          await client.runMaintenanceCommand.mutate({
            worktreePath: result.path,
            command: result.initCommand,
          });
        } catch (err) {
          console.error("Init command failed:", err);
        }
      }
    }

    // Refresh worktree list and select the target
    const updatedWorktrees = await client.getWorktrees.query({
      repoPath: currentRepo,
    });
    setWorktrees(updatedWorktrees);

    const targetWorktree = updatedWorktrees.find(wt => wt.path === targetWorktreePath);
    if (targetWorktree) {
      await handleWorktreeSelect(targetWorktree);
    }

    setShowNewTaskModal(false);

    // Launch the task command in a terminal after a brief delay for the UI to update
    setTimeout(() => {
      if (pool.taskCommand) {
        mainContentRef.current?.launchTaskTerminal(
          { MANY_TASK_PROMPT: prompt },
          pool.taskCommand,
        );
      }
    }, 200);
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
    <div className="flex h-screen">
      {sidebarCollapsed && (
        <button
          className="btn btn-ghost btn-sm absolute top-2 left-2 z-10"
          onClick={() => setSidebarCollapsed(false)}
          title="Show sidebar"
        >
          &#9776;
        </button>
      )}
      {!sidebarCollapsed && <Sidebar
        repositories={repositories}
        currentRepo={currentRepo}
        worktrees={worktrees}
        selectedWorktree={selectedWorktree}
        pools={repoConfig?.pools}
        onRepoSelect={selectRepo}
        onWorktreeSelect={handleWorktreeSelect}
        onAddRepo={() => setShowAddRepoModal(true)}
        onCreateWorktree={() => setShowCreateModal(true)}
        onConfigRepo={() => setShowRepoConfigModal(true)}
        onSwitchWorktree={() => setShowSwitchModal(true)}
        onClaimPool={handleClaimPool}
        onNewTask={() => setShowNewTaskModal(true)}
        onGlobalSettings={() => setShowGlobalSettingsModal(true)}
        onCollapse={() => setSidebarCollapsed(true)}
      />}

      <MainContent
        ref={mainContentRef}
        selectedWorktree={selectedWorktree}
        currentRepo={currentRepo}
        pools={repoConfig?.pools}
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
          onCreatePool={createPoolWorktree}
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
          poolFilter={claimPoolTarget ?? undefined}
          onClose={() => {
            setShowSwitchModal(false);
            setClaimPoolTarget(null);
          }}
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

      {showNewTaskModal && repoConfig?.pools && (
        <NewTaskModal
          pools={repoConfig.pools}
          onClose={() => setShowNewTaskModal(false)}
          onLaunch={handleLaunchTask}
        />
      )}

      {showGlobalSettingsModal && (
        <GlobalSettingsModal
          onClose={() => setShowGlobalSettingsModal(false)}
        />
      )}
    </div>
  );
};

export default App;
