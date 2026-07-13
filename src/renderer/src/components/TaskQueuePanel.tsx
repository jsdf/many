import React, { useState, useEffect, useRef } from "react";
import type { TaskRecord } from "../../../shared/protocol";
import { getRpcClient } from "../rpc-client";
import TopBar from "./TopBar";

interface TaskQueuePanelProps {
  currentRepo: string | null;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onViewAutomation?: (automationId: string) => void;
}

interface TaskAutomation {
  id: string;
  name: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const statusColors: Record<string, string> = {
  running: "badge-warning",
  completed: "badge-success",
  failed: "badge-error",
  unknown: "badge-neutral",
};

const TaskQueuePanel: React.FC<TaskQueuePanelProps> = ({ currentRepo, sidebarCollapsed, onExpandSidebar, onViewAutomation }) => {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskAutomations, setTaskAutomations] = useState<Record<string, TaskAutomation>>({});
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchTasks = async () => {
    if (!currentRepo) return;
    try {
      const [result, runs] = await Promise.all([
        getRpcClient().query("task.list", { repoPath: currentRepo }),
        getRpcClient().query("automation.listRuns", { repoPath: currentRepo }),
      ]);
      setTasks(result as TaskRecord[]);
      // Map each launched task back to the automation whose run produced it.
      const map: Record<string, TaskAutomation> = {};
      for (const run of runs) {
        for (const item of run.workItems) {
          if (item.taskId) map[item.taskId] = { id: run.automationId, name: run.automationName };
        }
      }
      setTaskAutomations(map);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setTasks([]);
    setSelectedTaskId(null);
    fetchTasks();

    pollRef.current = setInterval(fetchTasks, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [currentRepo]);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

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

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center px-4">
        <p className="text-base-content/50 italic text-sm text-center">
          No tasks running. Launch a task from a worktree or automation step.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        <h3 className="text-lg font-semibold m-0">Running Tasks</h3>
      </TopBar>

      <div className="flex flex-1 overflow-hidden">
        {/* Task list */}
        <div className="w-72 shrink-0 border-r border-base-300 overflow-y-auto">
          {tasks.map((task) => {
            const isSelected = selectedTaskId === task.id;

            return (
              <div
                key={task.id}
                className={`px-4 py-3 cursor-pointer transition-colors border-l-[3px] ${
                  isSelected
                    ? "border-l-primary bg-primary/15"
                    : "border-l-transparent hover:bg-base-content/5"
                }`}
                onClick={() => setSelectedTaskId(isSelected ? null : task.id)}
              >
                <div className="flex items-center gap-2">
                  <span className={`badge ${statusColors[task.status] ?? "badge-neutral"} badge-xs`}>
                    {task.status}
                  </span>
                  <span className="text-sm font-semibold leading-tight truncate">
                    {task.branch}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-base-content/50">
                    {new Date(task.startedAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-xs text-base-content/50 truncate">
                    {task.poolName}
                  </span>
                  {task.recursiveMemoryBytes !== undefined && (
                    <span className="text-xs text-base-content/50">
                      {formatBytes(task.recursiveMemoryBytes)}
                      {task.processCount ? ` · ${task.processCount} proc` : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Task detail */}
        <div className="flex-1 overflow-y-auto p-5">
          {selectedTask ? (
            <TaskDetail
              task={selectedTask}
              automation={taskAutomations[selectedTask.id]}
              onViewAutomation={onViewAutomation}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-base-content/50 italic text-sm">
                Select a task to view details
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const TaskDetail: React.FC<{
  task: TaskRecord;
  automation?: TaskAutomation;
  onViewAutomation?: (automationId: string) => void;
}> = ({ task, automation, onViewAutomation }) => {
  const [logContent, setLogContent] = useState("");
  const [logSize, setLogSize] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLog = async () => {
    try {
      const result = await getRpcClient().query("task.getLog", {
        taskId: task.id,
        offset: Math.max(0, logSize - 8192),
      });
      if (result.size > logSize) {
        setLogContent(result.content);
        setLogSize(result.size);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    setLogContent("");
    setLogSize(0);
    fetchLog();

    if (task.status === "running") {
      pollRef.current = setInterval(fetchLog, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [task.id, task.status]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logContent]);

  const handleKill = async () => {
    try {
      await getRpcClient().query("task.kill", { taskId: task.id });
    } catch (err) {
      console.error("Failed to kill task:", err);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h4 className="text-base font-semibold m-0">{task.branch}</h4>
        <span className={`badge ${statusColors[task.status] ?? "badge-neutral"} badge-sm`}>
          {task.status}
        </span>
        {task.status === "running" && (
          <button className="btn btn-error btn-xs" onClick={handleKill}>
            Kill
          </button>
        )}
        {automation && onViewAutomation && (
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => onViewAutomation(automation.id)}
            title="View the automation that launched this task"
          >
            Automation: {automation.name} &rarr;
          </button>
        )}
      </div>

      <div className="text-xs text-base-content/50 space-y-1">
        <div>Started: {new Date(task.startedAt).toLocaleString()}</div>
        {task.endedAt && <div>Ended: {new Date(task.endedAt).toLocaleString()}</div>}
        <div>Pool: {task.poolName}</div>
        {task.exitCode !== undefined && <div>Exit code: {task.exitCode}</div>}
        {task.recursiveMemoryBytes !== undefined && (
          <div>Memory (incl. children): {formatBytes(task.recursiveMemoryBytes)}{task.processCount ? ` across ${task.processCount} processes` : ""}</div>
        )}
      </div>

      {task.prompt && (
        <div>
          <h4 className="text-sm font-semibold mb-1">Prompt</h4>
          <div className="bg-base-300 rounded px-3 py-2 text-sm whitespace-pre-wrap">
            {task.prompt}
          </div>
        </div>
      )}

      {logContent && (
        <div>
          <h4 className="text-sm font-semibold mb-1">Log (tail)</h4>
          <div
            ref={logRef}
            className="bg-base-300 rounded-lg p-3 max-h-[400px] overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap"
          >
            {logContent}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskQueuePanel;
