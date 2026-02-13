import React, { useState, useEffect } from "react";
import { Worktree, GitStatus, isTmpBranch } from "../types";
import { client } from "../main";

const formatBranchName = (branch?: string | null) => {
  if (!branch) return "detached HEAD";
  return branch.replace(/^refs\/heads\//, "");
};

interface WorktreeDetailsProps {
  worktree: Worktree;
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
  onReleaseWorktree,
}) => {
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const loadGitStatus = async () => {
    if (!worktree.path) return;
    setStatusLoading(true);
    try {
      const status = await client.getWorktreeStatus.query({
        worktreePath: worktree.path,
      });
      setGitStatus(status);
    } catch (err) {
      console.error("Failed to load git status:", err);
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    loadGitStatus();
  }, [worktree.path]);

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

          {onReleaseWorktree && !isTmpBranch(worktree.branch) && (
            <button
              className="btn btn-secondary"
              onClick={() => onReleaseWorktree(worktree)}
              disabled={!worktree?.branch}
              title="Release this worktree back to the pool"
            >
              🔓 Release Worktree
            </button>
          )}

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
        <div className="git-status-header">
          <h3>Git Status</h3>
          <button
            className="btn btn-secondary"
            onClick={loadGitStatus}
            disabled={statusLoading}
          >
            {statusLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="status-info">
          {statusLoading && !gitStatus ? (
            <p>Loading...</p>
          ) : gitStatus && gitStatus.hasChanges ? (
            <div className="status-file-list">
              {gitStatus.staged.length > 0 && (
                <div className="status-section">
                  <h4 className="change-staged">
                    Staged ({gitStatus.staged.length})
                  </h4>
                  <ul>
                    {gitStatus.staged.map((file) => (
                      <li key={`staged-${file}`} className="change-staged">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.modified.length > 0 && (
                <div className="status-section">
                  <h4 className="change-modified">
                    Modified ({gitStatus.modified.length})
                  </h4>
                  <ul>
                    {gitStatus.modified.map((file) => (
                      <li key={`modified-${file}`} className="change-modified">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.not_added.length > 0 && (
                <div className="status-section">
                  <h4 className="change-untracked">
                    Untracked ({gitStatus.not_added.length})
                  </h4>
                  <ul>
                    {gitStatus.not_added.map((file) => (
                      <li
                        key={`untracked-${file}`}
                        className="change-untracked"
                      >
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.deleted.length > 0 && (
                <div className="status-section">
                  <h4 className="change-deleted">
                    Deleted ({gitStatus.deleted.length})
                  </h4>
                  <ul>
                    {gitStatus.deleted.map((file) => (
                      <li key={`deleted-${file}`} className="change-deleted">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.created.length > 0 && (
                <div className="status-section">
                  <h4 className="change-staged">
                    Created ({gitStatus.created.length})
                  </h4>
                  <ul>
                    {gitStatus.created.map((file) => (
                      <li key={`created-${file}`} className="change-staged">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : gitStatus ? (
            <p className="text-success" style={{ margin: 0 }}>
              Working tree clean
            </p>
          ) : (
            <p>Failed to load status</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorktreeDetails;