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
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
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
    setExpandedRunId(null);
    fetchRuns();

    pollRef.current = setInterval(fetchRuns, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [currentRepo]);

  if (!currentRepo) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-base-content/50 italic text-sm">
          Select a repository
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="loading loading-spinner loading-md"></span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-base-content/50 italic text-sm text-center">
          No automation runs yet
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto mb-3">
      {runs.map((run) => {
        const isExpanded = expandedRunId === run.id;
        const completedCount = run.workItems.filter(
          (i) => i.status === "completed"
        ).length;
        const failedCount = run.workItems.filter(
          (i) => i.status === "failed"
        ).length;
        const totalCount = run.workItems.length;

        return (
          <div key={run.id} className="mb-1">
            <div
              className={`px-3 py-2 cursor-pointer transition-colors border-l-[3px] rounded-none ${
                isExpanded
                  ? "border-l-primary bg-primary/15"
                  : "border-l-transparent hover:bg-base-content/5"
              }`}
              onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
            >
              <div className="flex items-center gap-2">
                <span className={`badge ${statusColors[run.status]} badge-xs`}>
                  {run.status}
                </span>
                <span className="text-sm font-semibold leading-tight truncate">
                  {run.automationName}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-base-content/50">
                  {new Date(run.startedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {totalCount > 0 && (
                  <span className="text-[11px] text-base-content/50">
                    {completedCount}/{totalCount}
                    {failedCount > 0 && (
                      <span className="text-error"> ({failedCount} failed)</span>
                    )}
                  </span>
                )}
              </div>
            </div>

            {isExpanded && run.workItems.length > 0 && (
              <div className="pl-4 pr-2 py-1 space-y-0.5">
                {run.workItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-1.5 text-xs py-0.5"
                  >
                    <span className={`shrink-0 ${workItemColors[item.status]}`}>
                      {workItemIcons[item.status]}
                    </span>
                    <span
                      className="flex-1 min-w-0 truncate text-base-content/70"
                      title={item.prompt}
                    >
                      {item.prompt}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default TaskQueuePanel;
