import React, { useState, useEffect } from "react";
import { RepositoryConfig, PoolConfig } from "../types";
import { getRpcClient } from "../rpc-client";

interface AddRepoModalProps {
  mode: "add" | "config";
  currentRepo?: string | null;
  onClose: () => void;
  onAdd?: (repoPath: string) => Promise<void>;
  onSaveConfig?: (config: RepositoryConfig) => Promise<void>;
}

const emptyPool = (): PoolConfig => ({
  name: "",
  prefix: "",
  type: "recyclable",
});

const AddRepoModal: React.FC<AddRepoModalProps> = ({
  mode,
  currentRepo,
  onClose,
  onAdd,
  onSaveConfig,
}) => {
  const [repoPath, setRepoPath] = useState("");
  const [mainBranch, setMainBranch] = useState("");
  const [initCommand, setInitCommand] = useState("");
  const [worktreeDirectory, setWorktreeDirectory] = useState("");
  const [terminalLogDir, setTerminalLogDir] = useState("");
  const [pools, setPools] = useState<PoolConfig[]>([]);
  const [defaultTaskPool, setDefaultTaskPool] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultBranches = ["main", "master", "dev", "develop", "trunk"];
  const isConfigMode = mode === "config";

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
    const loadConfigData = async () => {
      if (isConfigMode && currentRepo) {
        setIsLoadingBranches(true);
        try {
          const config = await getRpcClient().query("repo.getConfig", { repoPath: currentRepo });
          setMainBranch(config.mainBranch || "");
          setInitCommand(config.initCommand || "");
          setWorktreeDirectory(config.worktreeDirectory || "");
          setTerminalLogDir(config.terminalLogDir || "");
          setPools(config.pools || []);
          setDefaultTaskPool(config.defaultTaskPool || "");

          const repoBranches = await getRpcClient().query("branch.list", {
            repoPath: currentRepo
          });
          setBranches(repoBranches);

          if (!config.mainBranch) {
            const defaultBranch = defaultBranches.find((branch) =>
              repoBranches.includes(branch)
            );
            if (defaultBranch) {
              setMainBranch(defaultBranch);
            } else if (repoBranches.length > 0) {
              setMainBranch(repoBranches[0]);
            }
          }
        } catch (error) {
          console.error("Failed to load config data:", error);
          setError("Failed to load repository data");
        } finally {
          setIsLoadingBranches(false);
        }
      }
    };

    loadConfigData();
  }, [isConfigMode, currentRepo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isConfigMode) {
      if (!mainBranch.trim()) {
        setError("Please select a main branch");
        return;
      }

      const validPools = pools.filter(p => p.name.trim() && p.prefix.trim());

      setIsLoading(true);
      setError(null);

      try {
        await onSaveConfig!({
          mainBranch: mainBranch.trim(),
          initCommand: initCommand.trim() || null,
          worktreeDirectory: worktreeDirectory.trim() || null,
          terminalLogDir: terminalLogDir.trim() || null,
          pools: validPools.length > 0 ? validPools : undefined,
          defaultTaskPool: defaultTaskPool || null,
        });
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Failed to save configuration"
        );
      } finally {
        setIsLoading(false);
      }
    } else {
      if (!repoPath.trim()) {
        setError("Please enter a repository path");
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        await onAdd!(repoPath.trim());
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Failed to add repository"
        );
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleBrowse = async () => {
    // selectFolder is not supported in the new RPC client
    setError("Folder picker is not available — please type the path manually");
  };

  const handleBrowseWorktreeDir = async () => {
    // selectFolder is not supported in the new RPC client
    setError("Folder picker is not available — please type the path manually");
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const updatePool = (index: number, updates: Partial<PoolConfig>) => {
    setPools(prev => prev.map((p, i) => i === index ? { ...p, ...updates } : p));
  };

  const removePool = (index: number) => {
    setPools(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div
        className="bg-base-200 border border-base-300 rounded-xl overflow-y-auto"
        style={{ width: '90%', maxWidth: isConfigMode ? 600 : 500, maxHeight: '90vh' }}
      >
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">
            {isConfigMode ? "Repository Configuration" : "Add Repository"}
          </h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-5">
            {isConfigMode ? (
              <>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="main-branch-select">Main branch:</label>
                  <select
                    id="main-branch-select"
                    className="select select-bordered w-full"
                    value={mainBranch}
                    onChange={(e) => setMainBranch(e.target.value)}
                    disabled={isLoading || isLoadingBranches}
                  >
                    {isLoadingBranches ? (
                      <option value="">Loading branches...</option>
                    ) : (
                      <>
                        {branches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <p className="text-xs text-base-content/50 mt-1.5">
                    This branch will be used as the default base branch when creating new worktrees.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="init-command-input">
                    Initialization command (optional):
                  </label>
                  <input
                    type="text"
                    id="init-command-input"
                    className="input input-bordered w-full"
                    value={initCommand}
                    onChange={(e) => setInitCommand(e.target.value)}
                    placeholder="e.g. npm install"
                    disabled={isLoading}
                  />
                  <p className="text-xs text-base-content/50 mt-1.5">
                    This command will be executed in each new worktree after it's created.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="worktree-directory-input">
                    Worktree directory (optional):
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      id="worktree-directory-input"
                      className="input input-bordered flex-1"
                      value={worktreeDirectory}
                      onChange={(e) => setWorktreeDirectory(e.target.value)}
                      placeholder="Leave empty to use parent directory of repo"
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      className="btn btn-soft btn-neutral"
                      onClick={handleBrowseWorktreeDir}
                      disabled={isLoading}
                    >
                      Browse...
                    </button>
                  </div>
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Directory where new worktrees will be created. Defaults to parent directory of the repository if not set.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="terminal-log-dir-input">
                    Terminal log directory (optional):
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      id="terminal-log-dir-input"
                      className="input input-bordered flex-1"
                      value={terminalLogDir}
                      onChange={(e) => setTerminalLogDir(e.target.value)}
                      placeholder="Leave empty to disable terminal logging"
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      className="btn btn-soft btn-neutral"
                      onClick={() => {
                        // selectFolder is not supported in the new RPC client
                        setError("Folder picker is not available — please type the path manually");
                      }}
                      disabled={isLoading}
                    >
                      Browse...
                    </button>
                  </div>
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Terminal output will be written to timestamped log files in this directory.
                  </p>
                </div>

                <div className="mb-5">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-sm font-medium">Worktree Pools:</label>
                    <button
                      type="button"
                      className="btn btn-soft btn-neutral btn-xs"
                      onClick={() => setPools(prev => [...prev, emptyPool()])}
                      disabled={isLoading}
                    >
                      + Add Pool
                    </button>
                  </div>
                  {pools.length === 0 ? (
                    <p className="text-xs text-base-content/50">
                      No pools configured. Worktrees will be shown in a flat list.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {pools.map((pool, i) => (
                        <div key={i} className="bg-base-100 border border-base-300 rounded p-2">
                          <div className="flex gap-1.5 items-center">
                            <input
                              type="text"
                              value={pool.name}
                              onChange={(e) => updatePool(i, { name: e.target.value })}
                              placeholder="Pool name"
                              disabled={isLoading}
                              className="input input-bordered input-sm flex-[2]"
                            />
                            <input
                              type="text"
                              value={pool.prefix}
                              onChange={(e) => updatePool(i, { prefix: e.target.value })}
                              placeholder="Prefix"
                              disabled={isLoading}
                              className="input input-bordered input-sm flex-1"
                            />
                            <select
                              value={pool.type}
                              onChange={(e) => updatePool(i, { type: e.target.value as PoolConfig['type'] })}
                              disabled={isLoading}
                              className="select select-bordered select-sm flex-1"
                            >
                              <option value="recyclable">Recyclable</option>
                              <option value="ephemeral">Ephemeral</option>
                            </select>
                            <button
                              type="button"
                              className="btn btn-soft btn-neutral btn-xs"
                              onClick={() => removePool(i)}
                              disabled={isLoading}
                              title="Remove pool"
                            >
                              x
                            </button>
                          </div>
                          {pool.type === 'recyclable' && (
                            <input
                              type="text"
                              value={pool.maintenanceCommand || ""}
                              onChange={(e) => updatePool(i, { maintenanceCommand: e.target.value || undefined })}
                              placeholder="Maintenance command (optional, e.g. npm install)"
                              disabled={isLoading}
                              className="input input-bordered input-sm w-full mt-1"
                            />
                          )}
                          <input
                            type="text"
                            value={pool.taskCommand || ""}
                            onChange={(e) => updatePool(i, { taskCommand: e.target.value || undefined })}
                            placeholder="Task command (optional, e.g. claude --dangerously-skip-permissions)"
                            disabled={isLoading}
                            className="input input-bordered input-sm w-full mt-1"
                          />
                          <input
                            type="text"
                            value={pool.backgroundTaskCommand || ""}
                            onChange={(e) => updatePool(i, { backgroundTaskCommand: e.target.value || undefined })}
                            placeholder="Background task command (optional, used by CLI instead of task command)"
                            disabled={isLoading}
                            className="input input-bordered input-sm w-full mt-1"
                          />
                          <input
                            type="text"
                            value={pool.claudeCommand || ""}
                            onChange={(e) => updatePool(i, { claudeCommand: e.target.value || undefined })}
                            placeholder="Claude command (optional, e.g. claude-wrapper, used for resume)"
                            disabled={isLoading}
                            className="input input-bordered input-sm w-full mt-1"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Group worktrees by name prefix. Recyclable pools have claim/release; ephemeral pools are one-time use.
                  </p>
                </div>

                {pools.filter(p => p.taskCommand).length > 0 && (
                  <div className="mb-5">
                    <label className="block mb-2 text-sm font-medium">Default task pool:</label>
                    <select
                      className="select select-bordered w-full"
                      value={defaultTaskPool}
                      onChange={(e) => setDefaultTaskPool(e.target.value)}
                      disabled={isLoading}
                    >
                      <option value="">First available</option>
                      {pools.filter(p => p.name.trim() && p.prefix.trim() && p.taskCommand).map((pool) => (
                        <option key={pool.prefix} value={pool.prefix}>
                          {pool.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-base-content/50 mt-1.5">
                      Pool pre-selected when opening the New Task modal.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="mb-5">
                <label className="block mb-2 text-sm font-medium" htmlFor="repo-path-input">Repository path:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    id="repo-path-input"
                    data-testid="repo-path-input"
                    className="input input-bordered flex-1"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    placeholder="/path/to/your/repo"
                    autoFocus
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    data-testid="browse-folder-button"
                    className="btn btn-soft btn-neutral"
                    onClick={handleBrowse}
                    disabled={isLoading}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            )}
            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>
          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button
              type="button"
              data-testid="add-repo-cancel"
              className="btn btn-neutral"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="add-repo-submit"
              className="btn btn-primary"
              disabled={
                isLoading ||
                (isConfigMode
                  ? !mainBranch.trim() || isLoadingBranches
                  : !repoPath.trim())
              }
            >
              {isLoading
                ? isConfigMode
                  ? "Saving..."
                  : "Adding..."
                : isConfigMode
                ? "Save Configuration"
                : "Add Repository"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddRepoModal;
