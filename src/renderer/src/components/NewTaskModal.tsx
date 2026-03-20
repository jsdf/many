import React, { useState } from "react";
import { PoolConfig } from "../types";

interface NewTaskModalProps {
  pools: PoolConfig[];
  onClose: () => void;
  onLaunch: (pool: PoolConfig, prompt: string, startingPoint?: string) => Promise<void>;
}

const NewTaskModal: React.FC<NewTaskModalProps> = ({
  pools,
  onClose,
  onLaunch,
}) => {
  const taskPools = pools.filter((p) => p.taskCommand);
  const [selectedPoolIndex, setSelectedPoolIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [startingPoint, setStartingPoint] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPool = taskPools[selectedPoolIndex];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPool || !prompt.trim()) return;

    setIsLaunching(true);
    setError(null);

    try {
      await onLaunch(
        selectedPool,
        prompt.trim(),
        startingPoint.trim() || undefined,
      );
    } catch (err: any) {
      setError(err.message || "Failed to launch task");
      setIsLaunching(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">New Task</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-5">
            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="task-pool-select">Pool</label>
              <select
                id="task-pool-select"
                className="select select-bordered w-full"
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
                <p className="text-xs text-base-content/50 mt-1.5">
                  Command: <code className="font-mono">{selectedPool.taskCommand}</code>
                </p>
              )}
            </div>

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="task-prompt">Prompt</label>
              <textarea
                id="task-prompt"
                className="textarea textarea-bordered w-full"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the task. This will be passed as the $MANY_TASK_PROMPT environment variable to the task command."
                disabled={isLaunching}
                rows={6}
                autoFocus
              />
            </div>

            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="task-starting-point">Starting point (optional)</label>
              <input
                id="task-starting-point"
                type="text"
                className="input input-bordered w-full"
                value={startingPoint}
                onChange={(e) => setStartingPoint(e.target.value)}
                placeholder="Branch name, PR #, GitHub PR URL, or Graphite PR URL"
                disabled={isLaunching}
              />
              <p className="text-xs text-base-content/50 mt-1.5">
                If set, this branch will be fetched and checked out before running the task command.
              </p>
            </div>

            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}
          </div>

          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button
              type="button"
              className="btn btn-neutral"
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
