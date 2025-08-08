import React, { useState, useEffect } from "react";
import { RepositoryConfig } from "../types";
import { client } from "../main";

interface AddRepoModalProps {
  mode: "add" | "config";
  currentRepo?: string | null;
  onClose: () => void;
  onAdd?: (repoPath: string) => Promise<void>;
  onSaveConfig?: (config: RepositoryConfig) => Promise<void>;
}

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
          // Load current config
          const config = await client.getRepoConfig.query({ repoPath: currentRepo });
          setMainBranch(config.mainBranch || "");
          setInitCommand(config.initCommand || "");
          setWorktreeDirectory(config.worktreeDirectory || "");

          // Load available branches
          const repoBranches = await client.getBranches.query({
            repoPath: currentRepo
          });
          setBranches(repoBranches);

          // Auto-select default if no main branch is configured
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

      setIsLoading(true);
      setError(null);

      try {
        await onSaveConfig!({
          mainBranch: mainBranch.trim(),
          initCommand: initCommand.trim() || null,
          worktreeDirectory: worktreeDirectory.trim() || null,
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
    try {
      const folderPath = await client.selectFolder.mutate();
      if (folderPath) {
        setRepoPath(folderPath);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      setError("Failed to open folder picker");
    }
  };

  const handleBrowseWorktreeDir = async () => {
    try {
      const folderPath = await client.selectFolder.mutate();
      if (folderPath) {
        setWorktreeDirectory(folderPath);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      setError("Failed to open folder picker");
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal show" onClick={handleBackdropClick}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>
            {isConfigMode ? "Repository Configuration" : "Add Repository"}
          </h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {isConfigMode ? (
              <>
                <div className="form-group">
                  <label htmlFor="main-branch-select">Main branch:</label>
                  <select
                    id="main-branch-select"
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
                  <p
                    style={{
                      fontSize: "13px",
                      color: "#8c8c8c",
                      marginTop: "8px",
                    }}
                  >
                    This branch will be used as the default base branch when
                    creating new worktrees.
                  </p>
                </div>
                <div className="form-group">
                  <label htmlFor="init-command-input">
                    Initialization command (optional):
                  </label>
                  <input
                    type="text"
                    id="init-command-input"
                    value={initCommand}
                    onChange={(e) => setInitCommand(e.target.value)}
                    placeholder="e.g. npm install"
                    disabled={isLoading}
                  />
                  <p
                    style={{
                      fontSize: "13px",
                      color: "#8c8c8c",
                      marginTop: "8px",
                    }}
                  >
                    This command will be executed in each new worktree after
                    it's created.
                  </p>
                </div>
                <div className="form-group">
                  <label htmlFor="worktree-directory-input">
                    Worktree directory (optional):
                  </label>
                  <div className="path-input-group">
                    <input
                      type="text"
                      id="worktree-directory-input"
                      value={worktreeDirectory}
                      onChange={(e) => setWorktreeDirectory(e.target.value)}
                      placeholder="Leave empty to use parent directory of repo"
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleBrowseWorktreeDir}
                      disabled={isLoading}
                    >
                      Browse...
                    </button>
                  </div>
                  <p
                    style={{
                      fontSize: "13px",
                      color: "#8c8c8c",
                      marginTop: "8px",
                    }}
                  >
                    Directory where new worktrees will be created. Defaults to
                    parent directory of the repository if not set.
                  </p>
                </div>
              </>
            ) : (
              <div className="form-group">
                <label htmlFor="repo-path-input">Repository path:</label>
                <div className="path-input-group">
                  <input
                    type="text"
                    id="repo-path-input"
                    data-testid="repo-path-input"
                    value={repoPath}
                    onChange={(e) => setRepoPath(e.target.value)}
                    placeholder="/path/to/your/repo"
                    autoFocus
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    data-testid="browse-folder-button"
                    className="btn btn-secondary"
                    onClick={handleBrowse}
                    disabled={isLoading}
                  >
                    Browse...
                  </button>
                </div>
              </div>
            )}
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              data-testid="add-repo-cancel"
              className="btn btn-secondary"
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
