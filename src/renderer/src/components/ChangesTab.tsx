import React, { useState, useEffect } from "react";
import { Worktree, GitStatus } from "../types";
import { getRpcClient } from "../rpc-client";
import BranchChanges from "./BranchChanges";

interface ChangesTabProps {
  worktree: Worktree;
  repoPath: string;
}

const ChangesTab: React.FC<ChangesTabProps> = ({ worktree, repoPath }) => {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const loadGitStatus = async () => {
    if (!worktree.path) return;
    setStatusLoading(true);
    try {
      const status = await getRpcClient().query("worktree.status", { worktreePath: worktree.path });
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
          <h3 className="text-base font-semibold">
            Git Status
            {gitStatus && !gitStatus.hasChanges && (
              <span className="text-xs font-normal text-success ml-2">clean</span>
            )}
            {gitStatus && gitStatus.hasChanges && (
              <span className="text-xs font-normal text-base-content/50 ml-2">
                {[
                  gitStatus.staged.length > 0 && `${gitStatus.staged.length} staged`,
                  gitStatus.modified.length > 0 && `${gitStatus.modified.length} modified`,
                  gitStatus.not_added.length > 0 && `${gitStatus.not_added.length} untracked`,
                  gitStatus.deleted.length > 0 && `${gitStatus.deleted.length} deleted`,
                  gitStatus.created.length > 0 && `${gitStatus.created.length} created`,
                ].filter(Boolean).join(", ")}
              </span>
            )}
          </h3>
          <button
            className="btn btn-outline btn-neutral btn-sm"
            onClick={loadGitStatus}
            disabled={statusLoading}
          >
            {statusLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="bg-neutral border border-base-content/10 rounded-lg p-4 text-neutral-content">
          {statusLoading && !gitStatus ? (
            <p className="text-neutral-content/60 italic m-0">Loading...</p>
          ) : gitStatus && gitStatus.hasChanges ? (
            <div className="flex flex-col gap-3">
              <pre className="text-sm m-0"><code>{[
                ...gitStatus.staged.map((file) => (
                  <span key={`staged-${file}`} className="text-success">A  {file}{"\n"}</span>
                )),
                ...gitStatus.modified.map((file) => (
                  <span key={`modified-${file}`} className="text-warning">M  {file}{"\n"}</span>
                )),
                ...gitStatus.not_added.map((file) => (
                  <span key={`untracked-${file}`} className="text-neutral-content/70">?  {file}{"\n"}</span>
                )),
                ...gitStatus.deleted.map((file) => (
                  <span key={`deleted-${file}`} className="text-error">D  {file}{"\n"}</span>
                )),
                ...gitStatus.created.map((file) => (
                  <span key={`created-${file}`} className="text-success">A  {file}{"\n"}</span>
                )),
              ]}</code></pre>
              {gitStatus.truncated && (
                <div className="text-warning text-xs mt-2 p-2 bg-warning/10 rounded">
                  Showing {gitStatus.staged.length + gitStatus.modified.length + gitStatus.not_added.length + gitStatus.deleted.length + gitStatus.created.length} of {gitStatus.totalFiles} files - too many to display in full.
                </div>
              )}
            </div>
          ) : gitStatus ? (
            <p className="text-success m-0">Working tree clean</p>
          ) : (
            <p className="text-neutral-content/60 italic m-0">Failed to load status</p>
          )}
        </div>
      </div>

      {worktree.path && repoPath && (
        <BranchChanges worktreePath={worktree.path} repoPath={repoPath} commit={worktree.commit} />
      )}
    </div>
  );
};

export default ChangesTab;
