import React, { useMemo } from "react";
import { Worktree } from "../types";
import TilingLayout, { Tile } from "./TilingLayout";
import WelcomeScreen from "./WelcomeScreen";
import WorktreeDetails from "./WorktreeDetails";
import Terminal from "./Terminal";
import { useWorktreeTerminals } from "../hooks/useWorktreeTerminals";

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
}

const MainContent: React.FC<MainContentProps> = ({
  selectedWorktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
}) => {
  const {
    terminalTileData,
    handleCloseTile,
    handleSplitTile,
    handleAddClaudeTerminal,
    updateTileTitle,
  } = useWorktreeTerminals({
    selectedWorktree,
  });

  // Convert tile data to actual tiles with React components
  const tiles = useMemo(() => {
    if (!selectedWorktree) return [];

    const tileList: Tile[] = [];

    // Add main content tile (handled directly in MainContent)
    tileList.push({
      id: `main-content-${selectedWorktree.path}`,
      type: "content",
      title: "Worktree Details",
      component: (
        <WorktreeDetails
          key={`worktree-details-${selectedWorktree.path}`}
          worktree={selectedWorktree}
          onArchiveWorktree={onArchiveWorktree}
          onMergeWorktree={onMergeWorktree}
          onRebaseWorktree={onRebaseWorktree}
        />
      ),
    });

    // Add terminal tiles from hook data
    terminalTileData.forEach((data) => {
      tileList.push({
        id: data.id,
        type: "terminal",
        title: data.title,
        component: (
          <Terminal
            key={data.id}
            workingDirectory={selectedWorktree.path}
            terminalId={data.terminalConfig!.id}
            onTitleChange={(title) =>
              updateTileTitle(data.terminalConfig!.id, title)
            }
            initialCommand={data.terminalConfig!.initialCommand}
            worktreePath={selectedWorktree.path}
          />
        ),
      });
    });

    return tileList;
  }, [
    selectedWorktree,
    terminalTileData,
    onArchiveWorktree,
    onMergeWorktree,
    onRebaseWorktree,
    updateTileTitle,
  ]);

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
        <div className="worktree-controls">
          <button
            className="btn btn-secondary"
            onClick={() => handleSplitTile("", "horizontal")}
            title="Add terminal"
          >
            + Terminal
          </button>
          <button
            className="btn btn-primary"
            onClick={() => handleAddClaudeTerminal()}
            title="Open Claude terminal"
          >
            🤖 Claude
          </button>
        </div>
      </div>

      <div className="tiling-container">
        <TilingLayout
          tiles={tiles}
          onCloseTile={handleCloseTile}
          onSplitTile={handleSplitTile}
        />
      </div>
    </div>
  );
};

export default MainContent;
