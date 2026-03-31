import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Worktree, PoolConfig, formatBranchName, findWorktreePool, isTmpBranch } from "../types";
import { getRpcClient } from "../rpc-client";
import WelcomeScreen from "./WelcomeScreen";
import WorktreeDetails from "./WorktreeDetails";
import TerminalStack, { TerminalStackHandle } from "./TerminalStack";

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  pools?: PoolConfig[];
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
  onClaimWorktree?: (worktree: Worktree) => void;
}

export interface MainContentHandle {
  launchTaskTerminal: (env: Record<string, string>, initialCommand: string, taskId?: string) => void;
}

const MIN_PANE_WIDTH = 200;
const DEFAULT_SPLIT = 0.5;

const MainContent = forwardRef<MainContentHandle, MainContentProps>(({
  selectedWorktree,
  currentRepo,
  pools,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
  onReleaseWorktree,
  onClaimWorktree,
}, ref) => {
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [ghLink, setGhLink] = useState<{ type: "pr" | "branch"; url: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalStackRef = useRef<TerminalStackHandle>(null);

  // Fetch GitHub PR/branch link with periodic revalidation
  const fetchGhLink = useCallback(() => {
    if (!selectedWorktree?.branch || !currentRepo || isTmpBranch(selectedWorktree.branch)) return;
    getRpcClient().query("repo.githubLink", {
      repoPath: currentRepo,
      branch: selectedWorktree.branch,
    }).then((result) => {
      setGhLink(result);
    }).catch(() => {
      // gh CLI not available or not a GitHub repo
    });
  }, [selectedWorktree?.branch, currentRepo]);

  // Reset and fetch on worktree change (path included so re-selecting triggers it)
  useEffect(() => {
    setGhLink(null);
    fetchGhLink();
  }, [selectedWorktree?.path, fetchGhLink]);

  // Revalidate every 30 seconds
  useEffect(() => {
    if (!selectedWorktree?.branch || !currentRepo || isTmpBranch(selectedWorktree.branch)) return;
    const interval = setInterval(fetchGhLink, 30_000);
    return () => clearInterval(interval);
  }, [fetchGhLink, selectedWorktree?.branch, currentRepo]);

  useImperativeHandle(ref, () => ({
    launchTaskTerminal: (env: Record<string, string>, initialCommand: string, taskId?: string) => {
      terminalStackRef.current?.createTerminalWithCommand(env, initialCommand, taskId);
    },
  }), []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const totalWidth = rect.width;
      const relX = e.clientX - rect.left;
      const fraction = relX / totalWidth;
      const minFraction = MIN_PANE_WIDTH / totalWidth;
      setSplitFraction(
        Math.max(minFraction, Math.min(1 - minFraction, fraction))
      );
    };

    const handleMouseUp = () => setDragging(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  const worktreePool = selectedWorktree ? findWorktreePool(selectedWorktree, pools) : null;
  const showRelease = worktreePool ? worktreePool.type === 'recyclable' : true;
  const isBaseWorktree = selectedWorktree?.path === currentRepo;
  const showArchive = !isBaseWorktree && !(worktreePool?.type === 'recyclable');

  const handleArchive = async () => {
    if (!selectedWorktree) return;
    const confirmed = confirm(
      `Are you sure you want to archive the worktree "${formatBranchName(selectedWorktree.branch)}"?\n\nThis will remove the working directory but keep the branch in git.`
    );
    if (!confirmed) return;
    setIsArchiving(true);
    try {
      await onArchiveWorktree(selectedWorktree);
    } finally {
      setIsArchiving(false);
    }
  };

  if (!selectedWorktree) {
    return <WelcomeScreen />;
  }

  return (
    <div className="flex flex-col p-0 h-screen w-full min-w-0 items-stretch justify-start flex-1">
      <div className="flex items-center gap-3 px-4 py-2 bg-base-200 border-b border-base-300 shrink-0 flex-wrap">
        <div className="mr-2">
          <h2 className="m-0 text-base font-semibold leading-tight">{formatBranchName(selectedWorktree.branch)}</h2>
          <span className="block text-xs text-base-content/50 leading-tight" title={selectedWorktree.path}>{selectedWorktree.worktreeName}</span>
        </div>

        <button
          className="btn btn-soft btn-neutral btn-sm"
          onClick={() => {
            if (!selectedWorktree.path) return;
            console.log("[action] openFileManager", selectedWorktree.path);
            getRpcClient().query("action.openFileManager", { path: selectedWorktree.path })
              .catch((err) => console.error("[action] openFileManager failed:", err));
          }}
        >
          📁 Folder
        </button>
        <button
          className="btn btn-soft btn-neutral btn-sm"
          onClick={() => {
            if (!selectedWorktree.path) return;
            console.log("[action] openEditor", selectedWorktree.path);
            getRpcClient().query("action.openEditor", { path: selectedWorktree.path })
              .catch((err) => console.error("[action] openEditor failed:", err));
          }}
        >
          📝 Editor
        </button>
        <button
          className="btn btn-soft btn-neutral btn-sm"
          onClick={() => {
            if (!selectedWorktree.path) return;
            console.log("[action] openTerminal", selectedWorktree.path);
            getRpcClient().query("action.openTerminal", { path: selectedWorktree.path })
              .catch((err) => console.error("[action] openTerminal failed:", err));
          }}
        >
          💻 Terminal
        </button>
        {isTmpBranch(selectedWorktree.branch) && onClaimWorktree && (
          <button
            className="btn btn-soft btn-primary btn-sm"
            onClick={() => onClaimWorktree(selectedWorktree)}
          >
            ⚡ Claim
          </button>
        )}

        {showRelease && onReleaseWorktree && !isTmpBranch(selectedWorktree.branch) && (
          <button
            className="btn btn-soft btn-neutral btn-sm"
            onClick={() => onReleaseWorktree(selectedWorktree)}
            title="Release this worktree back to the pool"
          >
            🔓 Release
          </button>
        )}

        <div className="ml-auto flex items-center gap-3">
          {showArchive && (
            <button
              className="btn btn-warning btn-sm"
              onClick={handleArchive}
              disabled={isArchiving}
            >
              📦 {isArchiving ? "Archiving..." : "Archive"}
            </button>
          )}

          {!isTmpBranch(selectedWorktree.branch) && (
            <a
              className={`btn btn-sm ${ghLink?.type === "pr" ? "btn-primary" : "btn-neutral"}`}
              href={ghLink?.url}
              target="_blank"
              rel="noopener noreferrer"
              style={ghLink ? undefined : { pointerEvents: "none", opacity: 0.5 }}
            >
              {ghLink?.type === "pr"
                ? `🔀 PR #${ghLink.url.match(/\/(\d+)$/)?.[1] ?? ""}`
                : "GitHub"}
            </a>
          )}
        </div>
      </div>

      <div
        className="flex-1 flex overflow-hidden min-h-0"
        ref={containerRef}
        style={{ userSelect: dragging ? "none" : undefined }}
      >
        <div
          className="overflow-y-auto min-w-[200px]"
          style={{ flex: `0 0 ${splitFraction * 100}%` }}
        >
          <WorktreeDetails
            key={`worktree-details-${selectedWorktree.path}`}
            worktree={selectedWorktree}
            repoPath={currentRepo!}
            onRetryTask={(env, command) => {
              terminalStackRef.current?.createTerminalWithCommand(env, command);
            }}
            onViewTaskLog={(taskId, isSavedLog) => {
              terminalStackRef.current?.openTaskLog(taskId, isSavedLog);
            }}
            onViewSessionHistory={(sessionId) => {
              terminalStackRef.current?.openSessionHistory(sessionId);
            }}
            onResumeSession={(sessionId) => {
              const cmd = worktreePool?.claudeCommand || "claude";
              terminalStackRef.current?.createTerminalWithCommand({}, `${cmd} --resume ${sessionId}`);
            }}
          />
        </div>

        <div
          className={`w-1 shrink-0 bg-base-300 cursor-ew-resize transition-colors ${dragging ? 'bg-primary' : 'hover:bg-primary'}`}
          onMouseDown={handleMouseDown}
        />

        <div className="flex-1 min-w-[200px] flex flex-col overflow-hidden">
          {selectedWorktree.path && (
            <TerminalStack
              key={`terminal-stack-${selectedWorktree.path}`}
              ref={terminalStackRef}
              worktreePath={selectedWorktree.path}
              repoPath={currentRepo || undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default MainContent;
