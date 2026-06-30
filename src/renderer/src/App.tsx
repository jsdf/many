import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Menu } from "lucide-react";
import { Repository, Worktree, RepositoryConfig, PoolConfig, MergeOptions, ProjectEntry, ProjectNode, OpenFile, isTmpBranch } from "./types";
import Sidebar, { AutomationsSubView } from "./components/Sidebar";
import MainContent, { MainContentHandle } from "./components/MainContent";
import ProjectsPanel, { ProjectsPanelHandle } from "./components/ProjectsPanel";
import ProjectsPalette from "./components/ProjectsPalette";
import WorktreePalette from "./components/WorktreePalette";
import { FileEditorsProvider } from "./useFileEditors";
import { useMediaQuery } from "./hooks/useMediaQuery";
import TaskQueuePanel from "./components/TaskQueuePanel";
import TrackedPanel from "./components/TrackedPanel";
import NewTaskModal from "./components/NewTaskModal";
import AutomationsModal from "./components/AutomationsModal";
import { useHashRouter, useNavHistory, NavState } from "./router";
import { NavContext } from "./nav-context";
import CreateWorktreeModal from "./components/CreateWorktreeModal";
import AddRepoModal from "./components/AddRepoModal";
import AddProjectModal from "./components/AddProjectModal";
import MergeWorktreeModal from "./components/MergeWorktreeModal";
import RebaseWorktreeModal from "./components/RebaseWorktreeModal";
import SwitchWorktreeModal from "./components/SwitchWorktreeModal";
import ReleaseWorktreeModal from "./components/ReleaseWorktreeModal";
import ArchiveWorktreeModal from "./components/ArchiveWorktreeModal";
import GlobalSettingsModal from "./components/GlobalSettingsModal";
import { WorktreeActivity } from "./treeActivity";
import { getRpcClient } from "./rpc-client";
import CloseProjectDialog from "./components/CloseProjectDialog";
import { useWorktreeSubscription, useConnectionStatus } from "./rpc-hooks";
import { ConnectionBanner } from "./components/ConnectionBanner";
import type { StreamEvent } from "../../shared/protocol";
import type { TaskLaunchState } from "./components/NewTaskModal";

const App: React.FC = () => {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(
    null
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);
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
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [worktreesToArchive, setWorktreesToArchive] = useState<Worktree[]>([]);
  const [showGlobalSettingsModal, setShowGlobalSettingsModal] = useState(false);
  const [repoConfig, setRepoConfig] = useState<RepositoryConfig | null>(null);
  const [claimPoolTarget, setClaimPoolTarget] = useState<PoolConfig | null>(null);
  const [claimPreselectedPath, setClaimPreselectedPath] = useState<string | null>(null);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [newTaskInitialBranch, setNewTaskInitialBranch] = useState<string | null>(null);
  const [taskLaunchState, setTaskLaunchState] = useState<TaskLaunchState | null>(null);
  const taskLaunchUnsubRef = useRef<(() => void) | null>(null);
  const { view: mainPaneView, navigate: setMainPaneView } = useHashRouter();
  const navHistory = useNavHistory();
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const [worktreeActivity, setWorktreeActivity] = useState<Record<string, { terminals: number; claudeSessions: number }>>({});
  const [starredWorktrees, setStarredWorktrees] = useState<Set<string>>(new Set());
  const [worktreeOrder, setWorktreeOrder] = useState<string[]>([]);
  const [pinnedFolders, setPinnedFolders] = useState<string[]>([]);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const mainContentRef = useRef<MainContentHandle>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [selectedNode, setSelectedNode] = useState<ProjectNode | null>(null);
  const projectsPanelRef = useRef<ProjectsPanelHandle>(null);
  // A recent Claude session the user clicked: switch to its project, then resume
  // it once ProjectsPanel has remounted for that project (see ProjectsPanel).
  const [pendingResume, setPendingResume] = useState<{ projectPath: string; sessionId: string; sessionType?: "chat" | "claude-code" } | null>(null);
  // A file the user picked from the palette: switch to its project, then open it
  // once ProjectsPanel has remounted for that project (see ProjectsPanel).
  const [pendingOpenFile, setPendingOpenFile] = useState<{ projectPath: string; file: OpenFile } | null>(null);
  const [worktreePendingResume, setWorktreePendingResume] = useState<{ worktreePath: string; sessionId: string; sessionType?: "chat" | "claude-code" } | null>(null);
  // A project pending a confirmed close (terminals would be killed).
  const [closeProjectTarget, setCloseProjectTarget] = useState<{ path: string; name: string; terminalCount: number } | null>(null);

  const mergedActivity = useMemo<Record<string, WorktreeActivity>>(() => {
    const out: Record<string, WorktreeActivity> = {};
    for (const [p, a] of Object.entries(worktreeActivity)) {
      out[p] = { terminals: a.terminals, claudeSessions: a.claudeSessions, openFiles: 0 };
    }
    return out;
  }, [worktreeActivity]);

  // Switch to a recent session's project and queue its resume.
  const handleResumeRecentSession = useCallback(
    (worktreePath: string, sessionId: string, sessionType?: "chat" | "claude-code") => {
      const sep = worktreePath.includes("\\") ? "\\" : "/";
      const name = worktreePath.slice(worktreePath.lastIndexOf(sep) + 1);
      setSelectedNode({ name, path: worktreePath });
      setMainPaneView({ type: "projects" });
      setPendingResume({ projectPath: worktreePath, sessionId, sessionType });
    },
    [setMainPaneView],
  );

  // Resume a session from the worktrees sidebar: select the worktree and queue a resume
  // in MainContent's terminal stack (no navigation to the projects pane).
  const handleResumeWorktreeSession = useCallback(
    (worktreePath: string, sessionId: string, sessionType?: "chat" | "claude-code") => {
      const wt = worktrees.find((w) => w.path === worktreePath);
      if (wt) setSelectedWorktree(wt);
      setWorktreePendingResume({ worktreePath, sessionId, sessionType });
    },
    [worktrees],
  );

  // Close a project: kill its terminals. Confirms first when terminals would be killed.
  const performCloseProject = useCallback(async (path: string) => {
    try {
      await getRpcClient().query("terminal.closeWorktree", { worktreePath: path });
    } catch (err) {
      console.error("[terminal.closeWorktree] failed:", err);
    }
    try {
      const activity = await getRpcClient().query("worktree.activity", {});
      setWorktreeActivity(activity);
    } catch {}
  }, []);

  const handleCloseProject = useCallback((path: string, name: string) => {
    const a = mergedActivity[path];
    const terminalCount = a?.terminals ?? 0;
    if (terminalCount > 0) {
      setCloseProjectTarget({ path, name, terminalCount });
    } else {
      performCloseProject(path);
    }
  }, [mergedActivity, performCloseProject]);

  // Record a navigation entry whenever the view or selection changes, so the
  // back/forward buttons can step through past view+selection combinations.
  // Restores from back/forward are suppressed inside the history hook.
  const { record: recordNav } = navHistory;
  useEffect(() => {
    recordNav({
      view: mainPaneView.type,
      worktreePath: selectedWorktree?.path ?? null,
      node: selectedNode,
    });
  }, [recordNav, mainPaneView.type, selectedWorktree?.path, selectedNode?.path]);

  // Apply a history entry: switch tabs and restore the worktree/node that was
  // selected then. The worktree path is resolved against the live list.
  const applyNavState = useCallback((s: NavState) => {
    setMainPaneView({ type: s.view });
    setSelectedNode(s.node);
    setSelectedWorktree(
      s.worktreePath ? worktrees.find((w) => w.path === s.worktreePath) ?? null : null,
    );
  }, [setMainPaneView, worktrees]);

  const goBack = useCallback(() => {
    const s = navHistory.back();
    if (s) applyNavState(s);
  }, [navHistory, applyNavState]);

  const goForward = useCallback(() => {
    const s = navHistory.forward();
    if (s) applyNavState(s);
  }, [navHistory, applyNavState]);

  useEffect(() => {
    setSidebarCollapsed(isNarrow);
  }, [isNarrow]);

  useEffect(() => {
    if (!draggingSidebar) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const dx = e.clientX - sidebarDragRef.current.startX;
      setSidebarWidth(Math.max(200, Math.min(600, sidebarDragRef.current.startWidth + dx)));
    };
    const onMouseUp = () => setDraggingSidebar(false);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [draggingSidebar]);

  useEffect(() => {
    loadSavedRepos();
    restoreSelectedRepo();
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      const list = await getRpcClient().query("projects.list", {});
      setProjects(list);
    } catch (err) {
      console.error("Failed to load projects:", err);
    }
  };

  const addProject = async (projectPath: string) => {
    await getRpcClient().query("projects.add", { projectPath });
    await loadProjects();
    setShowAddProjectModal(false);
  };

  const handleRemoveProject = async (project: ProjectEntry) => {
    if (!window.confirm(`Remove "${project.name}" from projects? (the directory is not deleted)`)) return;
    try {
      await getRpcClient().query("projects.remove", { projectPath: project.path });
      if (selectedNode && (selectedNode.path === project.path || selectedNode.path.startsWith(project.path + "/"))) setSelectedNode(null);
      await loadProjects();
    } catch (err) {
      console.error("Failed to remove project:", err);
    }
  };

  // Open a file in the projects panel from anywhere (e.g. the palette),
  // switching the selected node to the file's containing directory first so the
  // panel keeps the tab. Mirrors ProjectsTab.handleOpenFile's node resolution.
  const openProjectFile = useCallback((file: OpenFile, projectPath: string, projectName: string) => {
    const sep = file.path.includes("\\") ? "\\" : "/";
    const i = file.path.lastIndexOf(sep);
    const parentPath = i >= 0 ? file.path.slice(0, i) : projectPath;
    const node: ProjectNode =
      parentPath === projectPath
        ? { name: projectName, path: projectPath }
        : { name: parentPath.slice(parentPath.lastIndexOf(sep) + 1), path: parentPath };
    setSelectedNode(node);
    setMainPaneView({ type: "projects" });
    // Defer the open until ProjectsPanel has rendered for the new project, so the
    // file lands in the right project's editor (it's keyed per root path).
    setPendingOpenFile({ projectPath: node.path, file });
  }, [setMainPaneView]);

  useEffect(() => {
    const repo = repositories.find(r => r.path === currentRepo);
    document.title = "Many";
  }, [currentRepo, repositories]);

  // Subscribe to live worktree updates via WebSocket
  const subscribedWorktrees = useWorktreeSubscription(currentRepo);
  useEffect(() => {
    if (!subscribedWorktrees) return;
    setWorktrees(subscribedWorktrees);
    // Update selected worktree if it's in the new list
    if (selectedWorktree) {
      const updated = subscribedWorktrees.find(
        (w: Worktree) => w.path === selectedWorktree.path
      );
      if (updated) {
        setSelectedWorktree(updated);
      }
    }
  }, [subscribedWorktrees]);

  // Poll worktree activity (terminals + claude sessions) every 3 seconds
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const activity = await getRpcClient().query("worktree.activity", {});
        if (!cancelled) setWorktreeActivity(activity);
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Fallback for Cmd/Ctrl+P, app-wide: always swallow it so the browser print
  // dialog never opens, even on screens that don't implement quick-open. Each
  // screen registers its own Cmd+P behavior (see ProjectsPalette/WorktreePalette);
  // this guarantees the print dialog is suppressed regardless of who handles it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Load pinned folders once; they persist globally (not per-repo).
  useEffect(() => {
    getRpcClient()
      .query("folder.getPinned", {})
      .then(setPinnedFolders)
      .catch((err) => console.error("Failed to load pinned folders:", err));
  }, []);

  const togglePin = useCallback(async (path: string, pinned: boolean) => {
    setPinnedFolders((prev) =>
      pinned ? (prev.includes(path) ? prev : [...prev, path]) : prev.filter((p) => p !== path),
    );
    try {
      await getRpcClient().query("folder.setPinned", { path, pinned });
    } catch (err) {
      console.error("Failed to set pinned folder:", err);
    }
  }, []);

  const reorderPin = useCallback(async (order: string[]) => {
    setPinnedFolders(order);
    try {
      await getRpcClient().query("folder.reorderPinned", { order });
    } catch (err) {
      console.error("Failed to reorder pinned folders:", err);
    }
  }, []);

  const loadSavedRepos = async () => {
    try {
      const repos = await getRpcClient().query("repo.list", {});
      setRepositories(repos);
    } catch (error) {
      console.error("Failed to load saved repos:", error);
    }
  };

  const restoreSelectedRepo = async () => {
    try {
      const selectedRepo = await getRpcClient().query("repo.getSelected", {});
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
      await getRpcClient().query("repo.setSelected", { repoPath: null });
      return;
    }

    setCurrentRepo(repoPath);

    try {
      await getRpcClient().query("repo.setSelected", { repoPath });
      const [repoWorktrees, config, starred, order] = await Promise.all([
        getRpcClient().query("worktree.list", { repoPath }),
        getRpcClient().query("repo.getConfig", { repoPath }),
        getRpcClient().query("worktree.getStarred", { repoPath }),
        getRpcClient().query("worktree.getOrder", { repoPath }),
      ]);
      setRepoConfig(config);
      setWorktrees(repoWorktrees);
      setStarredWorktrees(new Set(starred));
      setWorktreeOrder(order);

      // Auto-select the most recent worktree or default to main/base branch
      if (repoWorktrees.length > 0) {
        let worktreeToSelect: Worktree | null = null;

        // First, try to get the most recently used worktree
        const recentWorktreePath = await getRpcClient().query("repo.recentWorktree", {
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
      await getRpcClient().query("repo.add", { repoPath });
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
      const result = await getRpcClient().query("worktree.create", {
        repoPath: currentRepo,
        branchName,
        baseBranch
      });
      console.log("Created worktree:", result);

      // Refresh the worktree list
      const updatedWorktrees = await getRpcClient().query("worktree.list", {
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
      return { ...result, initCommand: repoConfig?.initCommand ?? null };
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
      const result = await getRpcClient().query("worktree.createPool", {
        repoPath: currentRepo,
        worktreeName
      });
      console.log("Created pool worktree:", result);

      // Refresh the worktree list
      const updatedWorktrees = await getRpcClient().query("worktree.list", {
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
      await getRpcClient().query("repo.saveConfig", { repoPath: currentRepo, config });
      setRepoConfig(config);
      setShowRepoConfigModal(false);
    } catch (error) {
      console.error("Failed to save repo config:", error);
      throw error;
    }
  };

  const handleToggleStar = async (worktreePath: string) => {
    if (!currentRepo) return;
    const isStarred = starredWorktrees.has(worktreePath);
    const newSet = new Set(starredWorktrees);
    if (isStarred) newSet.delete(worktreePath);
    else newSet.add(worktreePath);
    setStarredWorktrees(newSet);
    try {
      await getRpcClient().query("worktree.setStarred", { repoPath: currentRepo, worktreePath, starred: !isStarred });
    } catch (error) {
      console.error("Failed to toggle star:", error);
    }
  };

  const handleReorderWorktrees = async (orderedPaths: string[]) => {
    if (!currentRepo) return;
    setWorktreeOrder(orderedPaths);
    try {
      await getRpcClient().query("worktree.setOrder", { repoPath: currentRepo, order: orderedPaths });
    } catch (error) {
      console.error("Failed to save worktree order:", error);
    }
  };

  const handleWorktreeSelect = async (worktree: Worktree | null) => {
    setSelectedWorktree(worktree);

    // Track the most recently selected worktree for this repo
    if (worktree && currentRepo) {
      try {
        if (worktree.path) {
          await getRpcClient().query("repo.setRecentWorktree", {
            repoPath: currentRepo,
            worktreePath: worktree.path
          });
        }
      } catch (error) {
        console.error("Failed to save recent worktree:", error);
      }
    }
  };

  const openArchiveModal = (worktreesToArchive: Worktree[]) => {
    setWorktreesToArchive(worktreesToArchive);
    setShowArchiveModal(true);
  };

  const handleArchiveComplete = async () => {
    if (!currentRepo) return;

    const updatedWorktrees = await getRpcClient().query("worktree.list", {
      repoPath: currentRepo,
    });
    setWorktrees(updatedWorktrees);

    // Clear selection if the archived worktree was selected
    if (selectedWorktree && worktreesToArchive.some(w => w.path === selectedWorktree.path)) {
      setSelectedWorktree(null);
    }

    setShowArchiveModal(false);
    setWorktreesToArchive([]);
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
      await getRpcClient().query("worktree.merge", {
        repoPath: currentRepo,
        fromBranch: worktreeToMerge.branch!,
        toBranch,
        options
      });

      // Refresh the worktree list
      const updatedWorktrees = await getRpcClient().query("worktree.list", {
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
        await getRpcClient().query("worktree.rebase", {
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
      await getRpcClient().query("worktree.claim", {
        repoPath: currentRepo,
        worktreePath,
        branchName
      });

      // If claiming from a pool with a maintenance command, run it
      const pool = claimPoolTarget;
      if (pool?.maintenanceCommand) {
        try {
          await getRpcClient().query("worktree.runMaintenance", {
            worktreePath,
            command: pool.maintenanceCommand,
          });
        } catch (err) {
          console.error("Maintenance command failed:", err);
          // Don't block the claim on maintenance failure
        }
      }

      // Refresh the worktree list
      const updatedWorktrees = await getRpcClient().query("worktree.list", {
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
      setClaimPreselectedPath(null);
    } catch (error) {
      console.error("Failed to switch worktree:", error);
      throw error;
    }
  };

  // Pool management: Claim a worktree from a specific pool
  const handleClaimPool = (pool: PoolConfig) => {
    setClaimPoolTarget(pool);
    setClaimPreselectedPath(null);
    setShowSwitchModal(true);
  };

  // Pool management: Claim a specific available worktree from the detail header
  const handleClaimWorktree = (worktree: Worktree) => {
    setClaimPoolTarget(null);
    setClaimPreselectedPath(worktree.path);
    setShowSwitchModal(true);
  };

  // Pool management: Release a worktree back to the pool
  const openReleaseModal = (worktree: Worktree) => {
    setWorktreeToRelease(worktree);
    setShowReleaseModal(true);
  };

  const handleLaunchTask = (params: {
    repoPath: string;
    pool: PoolConfig;
    prompt: string;
    startingPoint?: string;
  }) => {
    if (taskLaunchUnsubRef.current) {
      taskLaunchUnsubRef.current();
      taskLaunchUnsubRef.current = null;
    }

    setTaskLaunchState({ isLaunching: true, log: [], error: null, done: false });

    const unsubscribe = getRpcClient().subscribe(
      "stream.launchTask",
      (event: StreamEvent) => {
        if (event.type === "step" || event.type === "stdout" || event.type === "stderr") {
          setTaskLaunchState(prev => prev ? {
            ...prev,
            log: [...prev.log, { type: event.type, text: event.text }],
          } : prev);
        } else if (event.type === "error") {
          setTaskLaunchState(prev => prev ? {
            ...prev,
            log: [...prev.log, { type: "error", text: event.text }],
            error: event.text,
          } : prev);
        } else if (event.type === "done") {
          setTaskLaunchState(prev => prev ? {
            ...prev,
            done: true,
            isLaunching: false,
          } : prev);
          if (event.success && event.worktreePath) {
            handleTaskComplete(event.worktreePath, params.pool, params.prompt, event.taskId);
          }
          taskLaunchUnsubRef.current = null;
          unsubscribe();
        }
      },
      {
        repoPath: params.repoPath,
        poolType: params.pool.type,
        poolPrefix: params.pool.prefix,
        prompt: params.prompt,
        startingPoint: params.startingPoint,
        maintenanceCommand: params.pool.maintenanceCommand,
        taskCommand: params.pool.taskCommand,
      }
    );

    taskLaunchUnsubRef.current = unsubscribe;
  };

  const handleTaskComplete = async (worktreePath: string, pool: PoolConfig, prompt: string, taskId?: string) => {
    if (!currentRepo) return;

    const updatedWorktrees = await getRpcClient().query("worktree.list", {
      repoPath: currentRepo,
    });
    setWorktrees(updatedWorktrees);

    const targetWorktree = updatedWorktrees.find(wt => wt.path === worktreePath);
    if (targetWorktree) {
      await handleWorktreeSelect(targetWorktree);
    }

    setShowNewTaskModal(false);
    setTaskLaunchState(null);

    setTimeout(() => {
      if (pool.taskCommand) {
        mainContentRef.current?.launchTaskTerminal(
          { MANY_TASK_PROMPT: prompt },
          pool.taskCommand,
          taskId,
        );
      }
    }, 200);
  };

  const handleReleaseComplete = async () => {
    if (!currentRepo) return;

    // Refresh the worktree list
    const updatedWorktrees = await getRpcClient().query("worktree.list", {
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

  const connectionStatus = useConnectionStatus();

  return (
    <NavContext.Provider value={{ onBack: goBack, onForward: goForward, canBack: navHistory.canBack, canForward: navHistory.canForward }}>
    <FileEditorsProvider>
    <div className="flex flex-col h-screen">
      <ConnectionBanner status={connectionStatus} />
      <div className="flex flex-1 min-h-0">
      {sidebarCollapsed ? (
        isNarrow ? null : (
          <div className="w-10 shrink-0 bg-base-100 border-r border-base-300 flex flex-col items-center pt-2">
            <button
              className="btn btn-ghost btn-sm btn-square"
              onClick={() => setSidebarCollapsed(false)}
              title="Show sidebar"
            >
              <Menu size={16} />
            </button>
          </div>
        )
      ) : (
        <>
          <div style={{ width: sidebarWidth, minWidth: 200, maxWidth: 600, flexShrink: 0 }}>
            <Sidebar
              repositories={repositories}
              currentRepo={currentRepo}
              worktrees={worktrees}
              selectedWorktree={selectedWorktree}
              pools={repoConfig?.pools}
              worktreeActivity={mergedActivity}
              starredWorktrees={starredWorktrees}
              worktreeOrder={worktreeOrder}
              automationsSubView={mainPaneView.type === 'runningTasks' ? 'running' : mainPaneView.type === 'automations' ? 'definitions' : null}
              activeTab={
                mainPaneView.type === 'tracked' ? 'tracked'
                : mainPaneView.type === 'runningTasks' || mainPaneView.type === 'automations' ? 'automations'
                : mainPaneView.type === 'projects' ? 'projects'
                : 'worktrees'
              }
              showTrackedTab={repoConfig?.showTrackedTab ?? false}
              showAutomationsTab={repoConfig?.showAutomationsTab ?? false}
              projects={projects}
              selectedNode={selectedNode}
              pinnedFolders={pinnedFolders}
              onTogglePin={togglePin}
              onReorderPin={reorderPin}
              onRepoSelect={selectRepo}
              onWorktreeSelect={(worktree) => {
                handleWorktreeSelect(worktree);
                setMainPaneView({ type: 'worktree' });
              }}
              onCreateWorktree={() => setShowCreateModal(true)}
              onConfigRepo={() => setShowRepoConfigModal(true)}
              onSwitchWorktree={() => setShowSwitchModal(true)}
              onClaimPool={handleClaimPool}
              onNewTask={() => setShowNewTaskModal(true)}
              onNavigateWorktrees={() => setMainPaneView({ type: 'worktree' })}
              onNavigateTracked={() => setMainPaneView({ type: 'tracked' })}
              onNavigateProjects={() => setMainPaneView({ type: 'projects' })}
              onSelectNode={(node) => {
                setSelectedNode(node);
                setMainPaneView({ type: 'projects' });
              }}
              onAddProject={() => setShowAddProjectModal(true)}
              onRemoveProject={handleRemoveProject}
              onCloseProject={handleCloseProject}
              onResumeRecentSession={handleResumeRecentSession}
              onResumeWorktreeSession={handleResumeWorktreeSession}
              onAutomationsSubViewChange={(view: AutomationsSubView) => {
                if (view === 'running') setMainPaneView({ type: 'runningTasks' });
                else if (view === 'definitions') setMainPaneView({ type: 'automations' });
              }}
              onArchiveWorktrees={(wts) => openArchiveModal(wts)}
              onToggleStar={handleToggleStar}
              onReorderWorktrees={handleReorderWorktrees}
              onGlobalSettings={() => setShowGlobalSettingsModal(true)}
              onCollapse={() => setSidebarCollapsed(true)}
            />
          </div>
          <div
            className={`w-1 shrink-0 cursor-ew-resize transition-colors ${draggingSidebar ? 'bg-primary' : 'bg-base-300 hover:bg-primary'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
              setDraggingSidebar(true);
            }}
          />
        </>
      )}

      {mainPaneView.type === 'tracked' && currentRepo ? (
        <div className="flex-1 min-w-0">
          <TrackedPanel
            currentRepo={currentRepo}
            starredBranches={new Set(
              worktrees
                .filter((w) => starredWorktrees.has(w.path) && w.branch)
                .map((w) => w.branch!.replace(/^refs\/heads\//, ''))
            )}
            worktrees={worktrees}
            hasTaskPools={repoConfig?.pools?.some(p => p.taskCommand) ?? false}
            sidebarCollapsed={sidebarCollapsed && isNarrow}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            onGoToWorktree={(worktreePath) => {
              const wt = worktrees.find((w) => w.path === worktreePath);
              if (wt) {
                handleWorktreeSelect(wt);
                setMainPaneView({ type: 'worktree' });
              }
            }}
            onNewTask={(branch) => {
              setNewTaskInitialBranch(branch);
              setShowNewTaskModal(true);
            }}
          />
        </div>
      ) : mainPaneView.type === 'automations' && currentRepo ? (
        <div className="flex-1 min-w-0">
          <AutomationsModal
            currentRepo={currentRepo}
            sidebarCollapsed={sidebarCollapsed && isNarrow}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            onClose={() => setMainPaneView({ type: 'runningTasks' })}
          />
        </div>
      ) : mainPaneView.type === 'runningTasks' && currentRepo ? (
        <div className="flex-1 min-w-0">
          <TaskQueuePanel
            currentRepo={currentRepo}
            sidebarCollapsed={sidebarCollapsed && isNarrow}
            onExpandSidebar={() => setSidebarCollapsed(false)}
          />
        </div>
      ) : mainPaneView.type === 'projects' ? (
        <div className="flex-1 min-w-0">
          <ProjectsPanel
            ref={projectsPanelRef}
            project={selectedNode}
            pendingResume={pendingResume}
            onPendingResumeConsumed={() => setPendingResume(null)}
            pendingOpenFile={pendingOpenFile}
            onPendingOpenFileConsumed={() => setPendingOpenFile(null)}
            sidebarCollapsed={sidebarCollapsed && isNarrow}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            onGoToWorktree={(worktreePath) => {
              const wt = worktrees.find((w) => w.path === worktreePath);
              if (wt) {
                handleWorktreeSelect(wt);
                setMainPaneView({ type: 'worktree' });
              }
            }}
          />
        </div>
      ) : (
        <MainContent
          ref={mainContentRef}
          selectedWorktree={selectedWorktree}
          currentRepo={currentRepo}
          pools={repoConfig?.pools}
          sidebarCollapsed={sidebarCollapsed && isNarrow}
          onExpandSidebar={() => setSidebarCollapsed(false)}
          onArchiveWorktree={(worktree) => openArchiveModal([worktree])}
          onMergeWorktree={openMergeModal}
          onRebaseWorktree={openRebaseModal}
          onReleaseWorktree={openReleaseModal}
          onClaimWorktree={handleClaimWorktree}
          pendingResume={worktreePendingResume}
          onPendingResumeConsumed={() => setWorktreePendingResume(null)}
        />
      )}

      {/* Cmd+P quick-open for worktrees, everywhere except the projects screen
          (where Cmd+P opens file quick-open instead). */}
      <WorktreePalette
        active={mainPaneView.type !== 'projects'}
        worktrees={worktrees}
        selectedWorktree={selectedWorktree}
        onWorktreeSelect={(wt) => handleWorktreeSelect(wt)}
        onFileOpened={() => setMainPaneView({ type: 'worktree' })}
      />

      {/* Always mounted so Cmd+P is claimed on every pane (never the browser
          print dialog); it only opens the palette on the projects screen. */}
      <ProjectsPalette
        active={mainPaneView.type === 'projects'}
        projects={projects}
        selectedNode={selectedNode}
        onOpenFile={openProjectFile}
        onNewTerminal={() => projectsPanelRef.current?.newTerminal()}
      />

      {showCreateModal && (
        <CreateWorktreeModal
          currentRepo={currentRepo}
          pools={repoConfig?.pools}
          onClose={() => setShowCreateModal(false)}
          onCreate={createWorktree}
          onCreated={async (worktreePath: string) => {
            if (!currentRepo) return
            const updatedWorktrees = await getRpcClient().query("worktree.list", { repoPath: currentRepo })
            setWorktrees(updatedWorktrees)
            const newWt = updatedWorktrees.find(wt => wt.path === worktreePath)
            if (newWt) await handleWorktreeSelect(newWt)
          }}
        />
      )}

      {showAddRepoModal && (
        <AddRepoModal
          mode="add"
          onClose={() => setShowAddRepoModal(false)}
          onAdd={addRepository}
        />
      )}

      {showAddProjectModal && (
        <AddProjectModal
          onClose={() => setShowAddProjectModal(false)}
          onAdd={addProject}
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
          preSelectedWorktreePath={claimPreselectedPath ?? undefined}
          onClose={() => {
            setShowSwitchModal(false);
            setClaimPoolTarget(null);
            setClaimPreselectedPath(null);
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

      {showArchiveModal && worktreesToArchive.length > 0 && (
        <ArchiveWorktreeModal
          currentRepo={currentRepo}
          worktrees={worktreesToArchive}
          onClose={() => {
            setShowArchiveModal(false);
            setWorktreesToArchive([]);
          }}
          onArchive={handleArchiveComplete}
        />
      )}

      {showNewTaskModal && repoConfig?.pools && currentRepo && (
        <NewTaskModal
          pools={repoConfig.pools}
          currentRepo={currentRepo}
          defaultTaskPool={repoConfig.defaultTaskPool}
          initialBranch={newTaskInitialBranch}
          onClose={() => {
            setShowNewTaskModal(false);
            setNewTaskInitialBranch(null);
            if (!taskLaunchState?.isLaunching) setTaskLaunchState(null);
          }}
          onLaunch={handleLaunchTask}
          launchState={taskLaunchState}
        />
      )}

      {showGlobalSettingsModal && (
        <GlobalSettingsModal
          onClose={() => setShowGlobalSettingsModal(false)}
          onAddRepo={() => setShowAddRepoModal(true)}
        />
      )}

      {closeProjectTarget && (
        <CloseProjectDialog
          projectName={closeProjectTarget.name}
          terminalCount={closeProjectTarget.terminalCount}
          onConfirm={() => {
            performCloseProject(closeProjectTarget.path);
            setCloseProjectTarget(null);
          }}
          onClose={() => setCloseProjectTarget(null)}
        />
      )}

      </div>
    </div>
    </FileEditorsProvider>
    </NavContext.Provider>
  );
};

export default App;
