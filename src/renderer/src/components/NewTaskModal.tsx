import React, { useState } from "react";
import { PoolConfig } from "../types";

interface NewTaskModalProps {
  pools: PoolConfig[];
  onClose: () => void;
  onLaunch: (pool: PoolConfig, prompt: string) => Promise<void>;
}

const NewTaskModal: React.FC<NewTaskModalProps> = ({
  pools,
  onClose,
  onLaunch,
}) => {
  const taskPools = pools.filter((p) => p.taskCommand);
  const [selectedPoolIndex, setSelectedPoolIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPool = taskPools[selectedPoolIndex];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPool || !prompt.trim()) return;

    setIsLaunching(true);
    setError(null);

    try {
      await onLaunch(selectedPool, prompt.trim());
    } catch (err: any) {
      setError(err.message || "Failed to launch task");
      setIsLaunching(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleBackdropClick}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New Task</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="task-pool-select">Pool</label>
              <select
                id="task-pool-select"
                value={selectedPoolIndex}
                onChange={(e) => setSelectedPoolIndex(Number(e.target.value))}
                disabled={isLaunching}
              >
                {taskPools.map((pool, i) => (
                  <option key={pool.prefix} value={i}>
                    {pool.name} ({pool.type})
                  </option>
                ))}
              </select>
              {selectedPool && (
                <p className="form-hint">
                  Command: <code>{selectedPool.taskCommand}</code>
                </p>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="task-prompt">Prompt</label>
              <textarea
                id="task-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the task..."
                disabled={isLaunching}
                rows={6}
                autoFocus
              />
            </div>

            {error && <p className="form-error">{error}</p>}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isLaunching}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLaunching || !prompt.trim() || !selectedPool}
            >
              {isLaunching ? "Launching..." : "Launch Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewTaskModal;
