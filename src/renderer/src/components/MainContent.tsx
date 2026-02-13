import React from "react";
import { Worktree } from "../types";
import WelcomeScreen from "./WelcomeScreen";
import WorktreeDetails from "./WorktreeDetails";

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
}

const MainContent: React.FC<MainContentProps> = ({
  selectedWorktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
  onReleaseWorktree,
}) => {
  if (!selectedWorktree) {
    return <WelcomeScreen />;
  }

  return (
    <div className="main-content worktree-view">
      <div className="worktree-header">
        <div className="worktree-title">
          <h2>{selectedWorktree.branch || "Worktree"}</h2>
          <span className="worktree-path">{selectedWorktree.path}</span>
        </div>
      </div>

      <WorktreeDetails
        key={`worktree-details-${selectedWorktree.path}`}
        worktree={selectedWorktree}
        onArchiveWorktree={onArchiveWorktree}
        onMergeWorktree={onMergeWorktree}
        onRebaseWorktree={onRebaseWorktree}
        onReleaseWorktree={onReleaseWorktree}
      />
    </div>
  );
};

export default MainContent;
