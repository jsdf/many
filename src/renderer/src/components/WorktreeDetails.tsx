import React, { useState, useEffect } from "react";
import { Worktree, GitStatus, isTmpBranch, formatBranchName } from "../types";
import { client } from "../main";
import BranchChanges from "./BranchChanges";

interface WorktreeDetailsProps {
  worktree: Worktree;
  repoPath: string;
  onArchiveWorktree?: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  repoPath,
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
      await onArchiveWorktree!(worktree);
    });
  };

  const mergeWorktree = () => {
    onMergeWorktree(worktree);
  };

  const rebaseWorktree = () => {
    onRebaseWorktree(worktree);
  };

  return (
    <div className="p-5 overflow-auto h-full w-full min-w-0">
      <div className="mb-6">
        <h2 className="mb-4 text-lg font-semibold">Worktree Overview</h2>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 bg-base-200 border border-base-300 rounded-lg p-4">
          <div className="info-item">
            <label className="text-base-content/60 text-sm font-medium">Path:</label>
            <span className="text-sm font-mono" title={worktree.path}>{worktree.worktreeName}</span>
          </div>
          <div className="info-item">
            <label className="text-base-content/60 text-sm font-medium">Branch:</label>
            <span className="text-sm font-mono">{formatBranchName(worktree.branch)}</span>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-base font-semibold mb-4">Quick Actions</h3>
        <div className="flex gap-4 flex-wrap">
          <button
            className="btn btn-neutral"
            onClick={() => {
              if (worktree.path) {
                client.openInFileManager.mutate({ folderPath: worktree.path });
              }
            }}
          >
            📁 Open Folder
          </button>
          <button
            className="btn btn-neutral"
            onClick={() => {
              if (worktree.path) {
                client.openInEditor.mutate({ folderPath: worktree.path });
              }
            }}
          >
            📝 Open in Editor
          </button>
          <button
            className="btn btn-neutral"
            onClick={() => {
              if (worktree.path) {
                client.openInTerminal.mutate({ folderPath: worktree.path });
              }
            }}
          >
            💻 Open in Terminal
          </button>
        </div>

        {error && (
          <p className="text-error text-sm mt-2.5 p-2 bg-error/10 rounded">{error}</p>
        )}
      </div>

      <div className="mt-8 pt-5 border-t border-base-300">
        <h3 className="text-base font-semibold mb-4">Worktree Management</h3>
        <div className="flex gap-2.5 flex-wrap">
          {onReleaseWorktree && !isTmpBranch(worktree.branch) && (
            <button
              className="btn btn-neutral"
              onClick={() => onReleaseWorktree(worktree)}
              disabled={!worktree?.branch}
              title="Release this worktree back to the pool"
            >
              🔓 Release Worktree
            </button>
          )}

          {onArchiveWorktree && (
            <button
              className="btn btn-warning"
              onClick={archiveWorktree}
              disabled={isLoading === "archive"}
            >
              📦 {isLoading === "archive" ? "Archiving..." : "Archive Worktree"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-6">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-base font-semibold">Git Status</h3>
          <button
            className="btn btn-neutral btn-sm"
            onClick={loadGitStatus}
            disabled={statusLoading}
          >
            {statusLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="bg-base-200 border border-base-300 rounded-lg p-4">
          {statusLoading && !gitStatus ? (
            <p className="text-base-content/60 italic m-0">Loading...</p>
          ) : gitStatus && gitStatus.hasChanges ? (
            <div className="flex flex-col gap-3">
              {gitStatus.staged.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-success">
                    Staged ({gitStatus.staged.length})
                  </h4>
                  <ul className="list-none p-0 m-0">
                    {gitStatus.staged.map((file) => (
                      <li key={`staged-${file}`} className="text-sm font-mono py-0.5 text-success">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.modified.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-warning">
                    Modified ({gitStatus.modified.length})
                  </h4>
                  <ul className="list-none p-0 m-0">
                    {gitStatus.modified.map((file) => (
                      <li key={`modified-${file}`} className="text-sm font-mono py-0.5 text-warning">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.not_added.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-base-content/60">
                    Untracked ({gitStatus.not_added.length})
                  </h4>
                  <ul className="list-none p-0 m-0">
                    {gitStatus.not_added.map((file) => (
                      <li key={`untracked-${file}`} className="text-sm font-mono py-0.5 text-base-content/60">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.deleted.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-error">
                    Deleted ({gitStatus.deleted.length})
                  </h4>
                  <ul className="list-none p-0 m-0">
                    {gitStatus.deleted.map((file) => (
                      <li key={`deleted-${file}`} className="text-sm font-mono py-0.5 text-error">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gitStatus.created.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide mb-1.5 text-success">
                    Created ({gitStatus.created.length})
                  </h4>
                  <ul className="list-none p-0 m-0">
                    {gitStatus.created.map((file) => (
                      <li key={`created-${file}`} className="text-sm font-mono py-0.5 text-success">
                        {file}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : gitStatus ? (
            <p className="text-success m-0">Working tree clean</p>
          ) : (
            <p className="text-base-content/60 italic m-0">Failed to load status</p>
          )}
        </div>
      </div>

      {worktree.path && repoPath && (
        <BranchChanges worktreePath={worktree.path} repoPath={repoPath} />
      )}
    </div>
  );
};

export default WorktreeDetails;
