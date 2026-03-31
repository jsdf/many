import React, { useState, useEffect, useRef } from "react";
import { AutomationRun, AutomationRunStatus, WorkItemStatus } from "../types";
import { getRpcClient } from "../rpc-client";

interface TaskQueuePanelProps {
  currentRepo: string | null;
}

const statusColors: Record<AutomationRunStatus, string> = {
  producing: "badge-info",
  running: "badge-warning",
  completed: "badge-success",
  failed: "badge-error",
  cancelled: "badge-neutral",
};

const workItemIcons: Record<WorkItemStatus, string> = {
  pending: "\u25CB",
  running: "\u25CF",
  completed: "\u2713",
  failed: "\u2717",
};

const workItemColors: Record<WorkItemStatus, string> = {
  pending: "text-base-content/50",
  running: "text-info",
  completed: "text-success",
  failed: "text-error",
};

const TaskQueuePanel: React.FC<TaskQueuePanelProps> = ({ currentRepo }) => {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRuns = async () => {
    if (!currentRepo) return;
    try {
      const result = await getRpcClient().query("automation.listRuns", {
        repoPath: currentRepo,
      });
      setRuns(result as AutomationRun[]);
    } catch (err) {
      console.error("Failed to load automation runs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setRuns([]);
    setSelectedRunId(null);
    fetchRuns();

    pollRef.current = setInterval(fetchRuns, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [currentRepo]);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  if (!currentRepo) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <p className="text-base-content/50 italic text-sm">
          Select a repository
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <span className="loading loading-spinner loading-md"></span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-4">
        <p className="text-base-content/50 italic text-sm text-center">
          No automation runs yet. Create an automation and run it to see results here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center px-5 py-3 border-b border-base-300 shrink-0">
        <h3 className="text-lg font-semibold m-0">Task Queue</h3>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Run list */}
        <div className="w-72 shrink-0 border-r border-base-300 overflow-y-auto">
          {runs.map((run) => {
            const isSelected = selectedRunId === run.id;
            const completedCount = run.workItems.filter(
              (i) => i.status === "completed"
            ).length;
            const failedCount = run.workItems.filter(
              (i) => i.status === "failed"
            ).length;
            const totalCount = run.workItems.length;

            return (
              <div
                key={run.id}
                className={`px-4 py-3 cursor-pointer transition-colors border-l-[3px] ${
                  isSelected
                    ? "border-l-primary bg-primary/15"
                    : "border-l-transparent hover:bg-base-content/5"
                }`}
                onClick={() => setSelectedRunId(isSelected ? null : run.id)}
              >
                <div className="flex items-center gap-2">
                  <span className={`badge ${statusColors[run.status]} badge-xs`}>
                    {run.status}
                  </span>
                  <span className="text-sm font-semibold leading-tight truncate">
                    {run.automationName}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-base-content/50">
                    {new Date(run.startedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {totalCount > 0 && (
                    <span className="text-xs text-base-content/50">
                      {completedCount}/{totalCount}
                      {failedCount > 0 && (
                        <span className="text-error"> ({failedCount} failed)</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Run detail */}
        <div className="flex-1 overflow-y-auto p-5">
          {selectedRun ? (
            <RunDetail run={selectedRun} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-base-content/50 italic text-sm">
                Select a run to view details
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const RunDetail: React.FC<{ run: AutomationRun }> = ({ run }) => {
  const completedCount = run.workItems.filter((i) => i.status === "completed").length;
  const failedCount = run.workItems.filter((i) => i.status === "failed").length;
  const totalCount = run.workItems.length;
  const progressPct = totalCount > 0
    ? Math.round(((completedCount + failedCount) / totalCount) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h4 className="text-base font-semibold m-0">{run.automationName}</h4>
        <span className={`badge ${statusColors[run.status]} badge-sm`}>
          {run.status}
        </span>
      </div>

      <div className="text-xs text-base-content/50">
        Started: {new Date(run.startedAt).toLocaleString()}
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span>
              {completedCount}/{totalCount} completed
              {failedCount > 0 && (
                <span className="text-error ml-2">
                  ({failedCount} failed)
                </span>
              )}
            </span>
            <span>{progressPct}%</span>
          </div>
          <progress
            className="progress progress-primary w-full"
            value={completedCount + failedCount}
            max={totalCount}
          />
        </div>
      )}

      {/* Work items */}
      {run.workItems.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2">
            Work Items ({run.workItems.length})
          </h4>
          <div className="space-y-1">
            {run.workItems.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 text-sm bg-base-300 rounded px-3 py-2"
              >
                <span
                  className={`shrink-0 mt-0.5 ${workItemColors[item.status]}`}
                >
                  {workItemIcons[item.status]}
                </span>
                <span className="flex-1 min-w-0" title={item.prompt}>
                  {item.prompt}
                </span>
                <span
                  className={`shrink-0 text-xs ${workItemColors[item.status]}`}
                >
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskQueuePanel;
