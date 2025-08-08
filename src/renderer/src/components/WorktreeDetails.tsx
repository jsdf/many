import React, { useState } from "react";
import { Worktree } from "../types";
import { client } from "../main";

const formatBranchName = (branch?: string) => {
  if (!branch) return "detached HEAD";
  return branch.replace(/^refs\/heads\//, "");
};

interface WorktreeDetailsProps {
  worktree: Worktree;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
}) => {
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (
    action: string,
    actionFn: () => Promise<boolean | void>
  ) => {
    setIsLoading(action);
    setError(null);

    try {
      await actionFn();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Action failed");
    } finally {
      setIsLoading(null);
    }
  };

  const archiveWorktree = async () => {
    const confirmed = confirm(
      `Are you sure you want to archive the worktree "${formatBranchName(
        worktree.branch
      )}"?\n\nThis will remove the working directory but keep the branch in git.`
    );
    if (!confirmed) return;

    await handleAction("archive", async () => {
      await onArchiveWorktree(worktree);
    });
  };

  const mergeWorktree = () => {
    onMergeWorktree(worktree);
  };

  const rebaseWorktree = () => {
    onRebaseWorktree(worktree);
  };

  return (
    <div className="worktree-details-content">
      <div className="worktree-info">
        <h2>Worktree Overview</h2>
        <div className="info-grid">
          <div className="info-item">
            <label>Path:</label>
            <span>{worktree.path}</span>
          </div>
          <div className="info-item">
            <label>Branch:</label>
            <span>{worktree.branch || "detached HEAD"}</span>
          </div>
        </div>
      </div>

      <div className="worktree-actions">
        <h3>Quick Actions</h3>
        <div className="action-buttons">
          <button
            className="btn btn-secondary"
            onClick={() => {
              if (worktree.path) {
                client.openInFileManager.mutate({ folderPath: worktree.path });
              }
            }}
          >
            📁 Open Folder
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              if (worktree.path) {
                client.openInEditor.mutate({ folderPath: worktree.path });
              }
            }}
          >
            📝 Open in Editor
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              if (worktree.path) {
                client.openInTerminal.mutate({ folderPath: worktree.path });
              }
            }}
          >
            💻 Open in Terminal
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}
      </div>

      <div className="worktree-management-actions">
        <h3>Worktree Management</h3>
        <div className="management-buttons">
          <button
            className="btn btn-success"
            onClick={mergeWorktree}
            disabled={!worktree?.branch}
          >
            🔀 Merge Changes
          </button>

          <button
            className="btn btn-info"
            onClick={rebaseWorktree}
            disabled={!worktree?.branch}
          >
            🌿 Rebase Branch
          </button>

          <button
            className="btn btn-warning"
            onClick={archiveWorktree}
            disabled={isLoading === "archive"}
          >
            📦 {isLoading === "archive" ? "Archiving..." : "Archive Worktree"}
          </button>
        </div>
      </div>

      <div className="git-status">
        <h3>Git Status</h3>
        <div className="status-info">
          <p>Changes will appear here...</p>
        </div>
      </div>
    </div>
  );
};

export default WorktreeDetails;