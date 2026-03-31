import React, { useState, useEffect } from "react";
import { formatBranchName } from "../types";
import { getRpcClient } from '../rpc-client';

interface RebaseWorktreeModalProps {
  currentRepo: string | null;
  fromBranch: string;
  worktreePath: string;
  onClose: () => void;
  onRebase: (ontoBranch: string) => Promise<void>;
}

const RebaseWorktreeModal: React.FC<RebaseWorktreeModalProps> = ({
  currentRepo,
  fromBranch,
  worktreePath,
  onClose,
  onRebase,
}) => {
  const [ontoBranch, setOntoBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultBranches = ["main", "master", "dev", "develop", "trunk"];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const loadBranches = async () => {
      if (!currentRepo) return;

      setIsLoadingBranches(true);
      try {
        const [repoBranches, repoConfig] = await Promise.all([
          getRpcClient().query("branch.list", { repoPath: currentRepo }),
          getRpcClient().query("repo.getConfig", { repoPath: currentRepo }),
        ]);

        const availableBranches = repoBranches
          .filter((branch) => branch !== fromBranch)
          .map(formatBranchName);
        setBranches(availableBranches);

        let defaultBranch =
          formatBranchName(repoConfig.mainBranch || undefined) || "main";

        if (!availableBranches.includes(defaultBranch)) {
          defaultBranch =
            defaultBranches.find((branch) =>
              availableBranches.includes(branch)
            ) ||
            availableBranches[0] ||
            "";
        }

        setOntoBranch(defaultBranch);
      } catch (error) {
        console.error("Failed to load branches:", error);
        setError("Failed to load branch list");

        const fallbackBranches = defaultBranches.filter(
          (branch) => branch !== formatBranchName(fromBranch)
        );
        setBranches(fallbackBranches);
        setOntoBranch(fallbackBranches[0] || "");
      } finally {
        setIsLoadingBranches(false);
      }
    };

    loadBranches();
  }, [currentRepo, fromBranch]);

  const handleRebase = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!ontoBranch.trim()) {
      setError("Please select a target branch");
      return;
    }

    if (ontoBranch === formatBranchName(fromBranch)) {
      setError("Cannot rebase branch onto itself");
      return;
    }

    setIsRebasing(true);
    setError(null);

    try {
      await onRebase(ontoBranch);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Rebase failed");
    } finally {
      setIsRebasing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={onClose}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Rebase Branch</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="p-5">
          <p className="mb-4">
            Rebase <strong>{formatBranchName(fromBranch)}</strong> onto another branch.
          </p>

          <form onSubmit={handleRebase}>
            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="onto-branch">Target branch:</label>
              <div className="flex gap-2 items-center">
                <select
                  id="onto-branch"
                  className="select select-bordered flex-1"
                  value={ontoBranch}
                  onChange={(e) => setOntoBranch(e.target.value)}
                  disabled={isLoadingBranches || isRebasing}
                  required
                >
                  <option value="">Select target branch...</option>
                  {branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
                {isLoadingBranches && (
                  <span className="text-sm text-base-content/60">Loading...</span>
                )}
              </div>
            </div>

            <div className="mb-5 p-3 bg-base-100 border border-base-300 rounded-lg text-sm">
              <p className="mb-2">
                <strong>Note:</strong> This will rebase the current branch ({fromBranch}) onto {ontoBranch || "the selected branch"}. The operation will replay your commits on top of the target branch.
              </p>
              <p className="text-warning">
                <strong>Warning:</strong> Rebasing rewrites commit history. Only rebase branches that haven't been pushed or shared with others.
              </p>
            </div>

            {error && <div className="text-error text-sm mt-2 p-2 bg-error/10 rounded mb-4">{error}</div>}

            <div className="flex justify-end gap-3">
              <button type="button" className="btn btn-neutral" onClick={onClose} disabled={isRebasing}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={isRebasing || isLoadingBranches || !ontoBranch}
              >
                {isRebasing ? "Rebasing..." : "Rebase"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default RebaseWorktreeModal;
