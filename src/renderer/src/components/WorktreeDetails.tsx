import React, { useState, useEffect } from "react";
import { Worktree, GitStatus } from "../types";
import { client } from "../main";
import BranchChanges from "./BranchChanges";

interface WorktreeDetailsProps {
  worktree: Worktree;
  repoPath: string;
}

const WorktreeDetails: React.FC<WorktreeDetailsProps> = ({
  worktree,
  repoPath,
}) => {
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

  return (
    <div className="p-5 overflow-auto h-full w-full min-w-0">
      <div className="mb-3">
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
                      <li key={`staged-${file}`} className="text-sm font-mono py-0.5 text-success">{file}</li>
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
                      <li key={`modified-${file}`} className="text-sm font-mono py-0.5 text-warning">{file}</li>
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
                      <li key={`untracked-${file}`} className="text-sm font-mono py-0.5 text-base-content/60">{file}</li>
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
                      <li key={`deleted-${file}`} className="text-sm font-mono py-0.5 text-error">{file}</li>
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
                      <li key={`created-${file}`} className="text-sm font-mono py-0.5 text-success">{file}</li>
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
