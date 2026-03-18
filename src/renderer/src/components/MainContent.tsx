import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Worktree, PoolConfig, formatBranchName, findWorktreePool } from "../types";
import WelcomeScreen from "./WelcomeScreen";
import WorktreeDetails from "./WorktreeDetails";
import TerminalStack from "./TerminalStack";

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  pools?: PoolConfig[];
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
}

const MIN_PANE_WIDTH = 200;
const DEFAULT_SPLIT = 0.5;

const MainContent: React.FC<MainContentProps> = ({
  selectedWorktree,
  currentRepo,
  pools,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
  onReleaseWorktree,
}) => {
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Determine if release should be shown based on pool type
  const worktreePool = selectedWorktree ? findWorktreePool(selectedWorktree, pools) : null;
  const showRelease = worktreePool ? worktreePool.type === 'recyclable' : true;

  if (!selectedWorktree) {
    return <WelcomeScreen />;
  }

  return (
    <div className="main-content worktree-view">
      <div className="worktree-header">
        <div className="worktree-title">
          <h2>{formatBranchName(selectedWorktree.branch)}</h2>
          <span className="worktree-path">{selectedWorktree.path}</span>
        </div>
      </div>

      <div
        className="worktree-split-container"
        ref={containerRef}
        style={{ userSelect: dragging ? "none" : undefined }}
      >
        <div
          className="worktree-split-left"
          style={{ flex: `0 0 ${splitFraction * 100}%` }}
        >
          <WorktreeDetails
            key={`worktree-details-${selectedWorktree.path}`}
            worktree={selectedWorktree}
            repoPath={currentRepo!}
            onArchiveWorktree={onArchiveWorktree}
            onMergeWorktree={onMergeWorktree}
            onRebaseWorktree={onRebaseWorktree}
            onReleaseWorktree={showRelease ? onReleaseWorktree : undefined}
          />
        </div>

        <div
          className={`worktree-split-divider ${dragging ? "active" : ""}`}
          onMouseDown={handleMouseDown}
        />

        <div className="worktree-split-right">
          {selectedWorktree.path && (
            <TerminalStack
              key={`terminal-stack-${selectedWorktree.path}`}
              worktreePath={selectedWorktree.path}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default MainContent;
