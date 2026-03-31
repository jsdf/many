import React, { useState, useRef, useEffect } from "react";
import { AutomationRun, AutomationRunStatus, WorkItem } from "../types";
import { getRpcClient } from "../rpc-client";

interface AutomationRunModalProps {
  currentRepo: string;
  automationId: string;
  manualWorkItems?: string[];
  onClose: () => void;
}

type LogEntry = { type: "step" | "stdout" | "stderr" | "error"; text: string };

const statusColors: Record<AutomationRunStatus, string> = {
  producing: "badge-info",
  running: "badge-warning",
  completed: "badge-success",
  failed: "badge-error",
  cancelled: "badge-neutral",
};

const workItemStatusColors: Record<string, string> = {
  pending: "text-base-content/50",
  running: "text-info",
  completed: "text-success",
  failed: "text-error",
};

const AutomationRunModal: React.FC<AutomationRunModalProps> = ({
  currentRepo,
  automationId,
  manualWorkItems,
  onClose,
}) => {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [run, setRun] = useState<AutomationRun | null>(null);
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // Start the automation run on mount
  useEffect(() => {
    startRun();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  // Poll for run status updates while running
  useEffect(() => {
    if (!run?.id || done) return;

    pollRef.current = setInterval(async () => {
      try {
        const updated = await getRpcClient().query("automation.getRun", { runId: run.id });
        if (updated) {
          setRun(updated as AutomationRun);
          if (
            updated.status !== "producing" &&
            updated.status !== "running"
          ) {
            setDone(true);
            if (pollRef.current) clearInterval(pollRef.current);
          }
        }
      } catch {
        // ignore poll errors
      }
    }, 3000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [run?.id, done]);

  const startRun = () => {
    setIsRunning(true);
    setLog([]);
    setDone(false);

    const unsub = getRpcClient().subscribe(
      "stream.startAutomation",
      (event: any) => {
        if (
          event.type === "step" ||
          event.type === "stdout" ||
          event.type === "stderr" ||
          event.type === "error"
        ) {
          setLog((prev) => [...prev, { type: event.type, text: event.text }]);
        } else if (event.type === "done") {
          setDone(true);
          setIsRunning(false);
          // Fetch final run state from the registry
          // We need to find the run ID — poll listRuns for the most recent
          getRpcClient()
            .query("automation.listRuns", { repoPath: currentRepo })
            .then((runs: any) => {
              if (runs && runs.length > 0) {
                setRun(runs[0] as AutomationRun);
              }
            })
            .catch(() => {});
        }
      },
      {
        repoPath: currentRepo,
        automationId,
        ...(manualWorkItems ? { manualWorkItems } : {}),
      }
    );

    unsubRef.current = unsub;
  };

  const handleCancel = async () => {
    if (!run?.id) return;
    try {
      await getRpcClient().query("automation.cancelRun", { runId: run.id });
      setLog((prev) => [...prev, { type: "step", text: "Cancellation requested" }]);
    } catch (err: any) {
      console.error("Failed to cancel:", err);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isRunning) onClose();
  };

  const completedCount =
    run?.workItems.filter((i) => i.status === "completed").length ?? 0;
  const failedCount =
    run?.workItems.filter((i) => i.status === "failed").length ?? 0;
  const totalCount = run?.workItems.length ?? 0;
  const progressPct =
    totalCount > 0
      ? Math.round(((completedCount + failedCount) / totalCount) * 100)
      : 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[800px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold m-0">
              Automation Run
            </h3>
            {run && (
              <span className={`badge ${statusColors[run.status]} badge-sm`}>
                {run.status}
              </span>
            )}
          </div>
          <button
            className="btn btn-ghost btn-sm btn-circle text-base-content/60"
            onClick={onClose}
            disabled={isRunning}
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
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

          {/* Work items list */}
          {run && run.workItems.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">
                Work Items ({run.workItems.length})
              </h4>
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {run.workItems.map((item, i) => (
                  <div
                    key={item.id}
                    className="flex items-start gap-2 text-sm bg-base-300 rounded px-3 py-2"
                  >
                    <span
                      className={`shrink-0 mt-0.5 ${workItemStatusColors[item.status]}`}
                    >
                      {item.status === "pending" && "\u25CB"}
                      {item.status === "running" && "\u25CF"}
                      {item.status === "completed" && "\u2713"}
                      {item.status === "failed" && "\u2717"}
                    </span>
                    <span className="flex-1 min-w-0 truncate" title={item.prompt}>
                      {item.prompt}
                    </span>
                    <span
                      className={`shrink-0 text-xs ${workItemStatusColors[item.status]}`}
                    >
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Log output */}
          {log.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Log</h4>
              <div
                ref={logRef}
                className="bg-base-300 rounded-lg p-3 max-h-[250px] overflow-y-auto font-mono text-xs leading-relaxed"
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
                    {entry.type === "step" ? `\u2192 ${entry.text}` : entry.text}
                  </div>
                ))}
                {isRunning && (
                  <span className="loading loading-dots loading-xs text-base-content/50"></span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-base-300">
          {isRunning && run && (
            <button className="btn btn-error btn-sm" onClick={handleCancel}>
              Cancel
            </button>
          )}
          <button
            className="btn btn-neutral"
            onClick={onClose}
            disabled={isRunning}
          >
            {done ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AutomationRunModal;
