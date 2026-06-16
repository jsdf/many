import React, { useState, useEffect } from "react";
import { getRpcClient } from "../rpc-client";

interface AddProjectModalProps {
  onClose: () => void;
  onAdd: (projectPath: string) => Promise<void>;
}

const AddProjectModal: React.FC<AddProjectModalProps> = ({ onClose, onAdd }) => {
  const [projectPath, setProjectPath] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleBrowse = async () => {
    try {
      const result = await getRpcClient().query("action.selectFolder", {
        initialPath: projectPath || undefined,
      });
      if (result.path) setProjectPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Folder picker failed");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectPath.trim()) {
      setError("Please enter a directory path");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await onAdd(projectPath.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project");
      setIsLoading(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl overflow-y-auto" style={{ width: "90%", maxWidth: 500, maxHeight: "90vh" }}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Add Project</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-5">
            <label className="block mb-2 text-sm font-medium" htmlFor="project-path-input">Directory path:</label>
            <div className="flex gap-2">
              <input
                type="text"
                id="project-path-input"
                data-testid="project-path-input"
                className="input input-bordered flex-1"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="/path/to/your/project"
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
            <p className="text-xs text-base-content/50 mt-1.5">
              Add any local directory to browse its files and run terminals scoped to it.
            </p>
            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>
          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button type="button" className="btn btn-neutral" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" data-testid="add-project-submit" className="btn btn-primary" disabled={isLoading || !projectPath.trim()}>
              {isLoading ? "Adding..." : "Add Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddProjectModal;
