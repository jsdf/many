import React, { useState, useRef, useEffect } from "react";
import { PoolConfig } from "../types";

interface NewTaskModalProps {
  pools: PoolConfig[];
  currentRepo: string;
  defaultTaskPool?: string | null;
  onClose: () => void;
  onComplete: (worktreePath: string, pool: PoolConfig, prompt: string, taskId?: string) => void;
}

type LogEntry = { type: "step" | "stdout" | "stderr" | "error"; text: string };

const token = new URLSearchParams(window.location.search).get("token") ?? "";

const NewTaskModal: React.FC<NewTaskModalProps> = ({
  pools,
  currentRepo,
  defaultTaskPool,
  onClose,
  onComplete,
}) => {
  const taskPools = pools.filter((p) => p.taskCommand);
  const defaultIndex = defaultTaskPool
    ? Math.max(0, taskPools.findIndex((p) => p.prefix === defaultTaskPool))
    : 0;
  const [selectedPoolIndex, setSelectedPoolIndex] = useState(defaultIndex);
  const [prompt, setPrompt] = useState("");
  const [startingPoint, setStartingPoint] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const selectedPool = taskPools[selectedPoolIndex];

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPool || !prompt.trim()) return;

    setIsLaunching(true);
    setError(null);
    setLog([]);
    setDone(false);

    try {
      const response = await fetch(`${window.location.origin}/api/launch-task`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-token": token,
        },
        body: JSON.stringify({
          repoPath: currentRepo,
          poolType: selectedPool.type,
          poolPrefix: selectedPool.prefix,
          prompt: prompt.trim(),
          startingPoint: startingPoint.trim() || undefined,
          maintenanceCommand: selectedPool.maintenanceCommand,
          taskCommand: selectedPool.taskCommand,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "step") {
                setLog((prev) => [...prev, { type: "step", text: event.text }]);
              } else if (event.type === "stdout") {
                setLog((prev) => [...prev, { type: "stdout", text: event.text }]);
              } else if (event.type === "stderr") {
                setLog((prev) => [...prev, { type: "stderr", text: event.text }]);
              } else if (event.type === "error") {
                setLog((prev) => [...prev, { type: "error", text: event.text }]);
                setError(event.text);
              } else if (event.type === "done") {
                setDone(true);
                if (event.success && event.worktreePath) {
                  onComplete(event.worktreePath, selectedPool, prompt.trim(), event.taskId);
                }
              }
            } catch {
              // Skip malformed event
            }
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to launch task");
    } finally {
      setIsLaunching(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isLaunching) onClose();
  };

  const showLog = log.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[600px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">New Task</h3>
          <button
            className="btn btn-ghost btn-sm btn-circle text-base-content/60"
            onClick={onClose}
            disabled={isLaunching}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-5">
            <div className="mb-5">
              <label className="block mb-2 text-sm font-medium" htmlFor="task-pool-select">
                Pool
              </label>
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
              <label className="block mb-2 text-sm font-medium" htmlFor="task-prompt">
                Prompt
              </label>
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
              <label className="block mb-2 text-sm font-medium" htmlFor="task-starting-point">
                Starting point (optional)
              </label>
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

            {showLog && (
              <div
                ref={logRef}
                className="bg-base-300 rounded-lg p-3 max-h-[200px] overflow-y-auto font-mono text-xs leading-relaxed"
              >
                {log.map((entry, i) => (
                  <div
                    key={i}
                    className={
                      entry.type === "error"
                        ? "text-error"
                        : entry.type === "stderr"
                          ? "text-warning"
                          : entry.type === "step"
                            ? "text-info"
                            : "text-base-content/70"
                    }
                  >
                    {entry.type === "step" ? `→ ${entry.text}` : entry.text}
                  </div>
                ))}
                {isLaunching && (
                  <span className="loading loading-dots loading-xs text-base-content/50"></span>
                )}
              </div>
            )}

            {error && !showLog && (
              <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>
            )}
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
              disabled={isLaunching || !prompt.trim() || !selectedPool || (done && !error)}
            >
              {isLaunching ? "Launching..." : done && !error ? "Done" : "Launch Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewTaskModal;
