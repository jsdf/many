import React, { useState, useEffect } from "react";
import { AutomationDefinition, AutomationRunTarget, AutomationRun } from "../types";
import { getRpcClient } from "../rpc-client";
import TopBar from "./TopBar";
import { isValidCron } from "../../../shared/cron";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const runStatusColors: Record<string, string> = {
  running: "badge-warning",
  completed: "badge-success",
  failed: "badge-error",
  cancelled: "badge-neutral",
};

const DEFAULT_SYNC_SCRIPT = `set -euo pipefail
BRANCH="\${MANY_MAIN_BRANCH:-main}"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
if git rebase "origin/$BRANCH"; then
  git push
else
  echo "Rebase conflicts - invoking Claude to resolve"
  claude -p "/fix-merge-conflicts resolve the current rebase conflicts in $(pwd), then run 'git rebase --continue' until the rebase completes"
  # Safety: if the rebase is somehow still in progress, abort rather than push a bad state.
  if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    echo "Rebase still in progress after Claude; aborting" >&2
    git rebase --abort
    exit 1
  fi
  git push
fi
`;

interface AutomationsModalProps {
  currentRepo: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onClose: () => void;
  // When set (e.g. navigated from a running task), open the run history for
  // this automation directly. Call onHistoryConsumed once handled.
  initialHistoryAutomationId?: string | null;
  onHistoryConsumed?: () => void;
}

function generateId(): string {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const CLAUDE_SKILLS = [
  "rebase",
  "fix-merge-conflicts",
  "review",
  "security-review",
  "simplify",
  "pr-ci-failures",
  "pr-spot-check",
  "pr-sanity-check",
  "split-pr",
  "graphite",
  "init",
];

const AutomationsModal: React.FC<AutomationsModalProps> = ({
  currentRepo,
  sidebarCollapsed,
  onExpandSidebar,
  onClose,
  initialHistoryAutomationId,
  onHistoryConsumed,
}) => {
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [historyFor, setHistoryFor] = useState<AutomationDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [runStatus, setRunStatus] = useState<{ id: string; message: string; error: boolean } | null>(null);

  useEffect(() => {
    loadAutomations();
  }, [currentRepo]);

  // Open history directly when navigated here from a running task.
  useEffect(() => {
    if (!initialHistoryAutomationId || automations.length === 0) return;
    const match = automations.find((a) => a.id === initialHistoryAutomationId);
    if (match) setHistoryFor(match);
    onHistoryConsumed?.();
  }, [initialHistoryAutomationId, automations]);

  const loadAutomations = async () => {
    try {
      const [defs, runList] = await Promise.all([
        getRpcClient().query("automation.list", { repoPath: currentRepo }),
        getRpcClient().query("automation.listRuns", { repoPath: currentRepo }),
      ]);
      setAutomations(defs as AutomationDefinition[]);
      setRuns(runList as AutomationRun[]);
    } catch (err) {
      console.error("Failed to load automations:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (automation: AutomationDefinition) => {
    try {
      await getRpcClient().query("automation.save", {
        repoPath: currentRepo,
        automation,
      });
      await loadAutomations();
      setEditing(null);
    } catch (err) {
      console.error("Failed to save automation:", err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await getRpcClient().query("automation.delete", {
        repoPath: currentRepo,
        automationId: id,
      });
      await loadAutomations();
    } catch (err) {
      console.error("Failed to delete automation:", err);
    }
  };

  const handleRun = async (automation: AutomationDefinition) => {
    const prompt =
      automation.type === "skill"
        ? `/${automation.skillName}`
        : automation.prompt ?? "";
    const isMainRepo = automation.runTarget === "mainRepo";
    try {
      let worktreePath = "";
      if (!isMainRepo) {
        const repoConfig = await getRpcClient().query("repo.getConfig", { repoPath: currentRepo });
        const pool = repoConfig.pools?.find((p) => p.taskCommand || p.backgroundTaskCommand);
        if (!pool) {
          setRunStatus({ id: automation.id, message: "No task pool configured", error: true });
          return;
        }
      }
      getRpcClient().subscribe("stream.runAutomation", () => {}, {
        repoPath: currentRepo,
        automationId: automation.id,
        worktreePath,
        prompt: automation.type === "shell" ? undefined : prompt,
      });
      setRunStatus({ id: automation.id, message: "Launched", error: false });
    } catch (err) {
      console.error("Failed to run automation:", err);
      setRunStatus({ id: automation.id, message: "Failed to launch", error: true });
    }
  };

  const handleNew = () => {
    setEditing({
      id: generateId(),
      name: "",
      type: "custom",
      prompt: "",
    });
  };

  const handleNewSyncAutomation = () => {
    setEditing({
      id: generateId(),
      name: "Sync main with remote",
      type: "shell",
      runTarget: "mainRepo",
      schedule: { cron: "0 * * * *", enabled: true },
      script: DEFAULT_SYNC_SCRIPT,
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        <h3 className="text-lg font-semibold m-0">Automations</h3>
        <div className="ml-auto">
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            &larr; Back
          </button>
        </div>
      </TopBar>

      <div className="p-5 overflow-y-auto flex-1">
        {historyFor ? (
            <AutomationHistory
              automation={historyFor}
              runs={runs.filter((r) => r.automationId === historyFor.id)}
              onBack={() => setHistoryFor(null)}
            />
          ) : editing ? (
            <AutomationForm
              automation={editing}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              {loading ? (
                <div className="flex justify-center py-8">
                  <span className="loading loading-spinner loading-md"></span>
                </div>
              ) : automations.length === 0 ? (
                <p className="text-base-content/50 text-center py-8">
                  No automations defined yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {automations.map((a) => {
                    const lastRun = runs.find((r) => r.automationId === a.id);
                    return (
                    <div
                      key={a.id}
                      className="bg-base-300 rounded-lg p-4 flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{a.name}</div>
                        <div className="text-xs text-base-content/50 mt-1">
                          {a.type === "skill" ? (
                            <span className="badge badge-info badge-xs mr-1">skill</span>
                          ) : a.type === "shell" ? (
                            <span className="badge badge-warning badge-xs mr-1">shell</span>
                          ) : (
                            <span className="badge badge-neutral badge-xs mr-1">custom</span>
                          )}
                          {a.runTarget === "mainRepo" && (
                            <span className="badge badge-ghost badge-xs mr-1">main repo</span>
                          )}
                          {a.schedule?.enabled && (
                            <span className="badge badge-accent badge-xs mr-1" title="Scheduled">
                              {a.schedule.cron}
                            </span>
                          )}
                          {a.type === "skill"
                            ? `/${a.skillName}`
                            : a.type === "shell"
                              ? (a.script ?? "").slice(0, 80)
                              : (a.prompt ?? "").slice(0, 80)}
                        </div>
                        <div className="text-xs text-base-content/40 mt-1">
                          {lastRun
                            ? `Last run ${timeAgo(lastRun.startedAt)}`
                            : "Never run"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {runStatus?.id === a.id && (
                          <span
                            className={`text-xs ${runStatus.error ? "text-error" : "text-success"}`}
                          >
                            {runStatus.message}
                          </span>
                        )}
                        <button
                          className="btn btn-ghost btn-sm text-success"
                          onClick={() => handleRun(a)}
                          title="Run"
                        >
                          Run
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setHistoryFor(a)}
                          title="Run history"
                        >
                          History
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditing({ ...a })}
                          title="Edit"
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-sm text-error"
                          onClick={() => handleDelete(a.id)}
                          title="Delete"
                        >
                          Del
                        </button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 flex flex-col gap-2">
                <button className="btn btn-outline btn-primary w-full" onClick={handleNew}>
                  New Automation
                </button>
                <button className="btn btn-outline btn-neutral w-full" onClick={handleNewSyncAutomation}>
                  New: Sync main with remote
                </button>
              </div>
            </>
          )}
      </div>
    </div>
  );
};

// --- History sub-component ---

interface AutomationHistoryProps {
  automation: AutomationDefinition;
  runs: AutomationRun[];
  onBack: () => void;
}

const AutomationHistory: React.FC<AutomationHistoryProps> = ({
  automation,
  runs,
  onBack,
}) => {
  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          &larr; Back
        </button>
        <h4 className="text-base font-semibold m-0">History: {automation.name}</h4>
      </div>

      {runs.length === 0 ? (
        <p className="text-base-content/50 text-center py-8">
          This automation has not run yet.
        </p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <div key={run.id} className="bg-base-300 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <span className={`badge ${runStatusColors[run.status] ?? "badge-neutral"} badge-sm`}>
                  {run.status}
                </span>
                <span className="text-sm">{timeAgo(run.startedAt)}</span>
                <span className="text-xs text-base-content/50">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
              </div>
              {run.workItems.length > 0 && (
                <div className="mt-2 space-y-1">
                  {run.workItems.map((item) => (
                    <div key={item.id} className="text-xs text-base-content/60 flex items-start gap-2">
                      <span className={`badge ${runStatusColors[item.status] ?? "badge-neutral"} badge-xs mt-0.5`}>
                        {item.status}
                      </span>
                      <span className="whitespace-pre-wrap break-words min-w-0">
                        {item.prompt.slice(0, 200)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Form sub-component ---

interface AutomationFormProps {
  automation: AutomationDefinition;
  onSave: (automation: AutomationDefinition) => void;
  onCancel: () => void;
}

const AutomationForm: React.FC<AutomationFormProps> = ({
  automation,
  onSave,
  onCancel,
}) => {
  const [name, setName] = useState(automation.name);
  const [type, setType] = useState<"custom" | "skill" | "shell">(automation.type);
  const [prompt, setPrompt] = useState(automation.prompt ?? "");
  const [skillName, setSkillName] = useState(automation.skillName ?? "");
  const [script, setScript] = useState(automation.script ?? "");
  const [runTarget, setRunTarget] = useState<AutomationRunTarget>(automation.runTarget ?? "worktree");
  const [scheduleEnabled, setScheduleEnabled] = useState(automation.schedule?.enabled ?? false);
  const [cron, setCron] = useState(automation.schedule?.cron ?? "0 * * * *");

  const cronValid = isValidCron(cron);

  const isValid =
    name.trim() &&
    (type === "skill" ? skillName.trim() : type === "shell" ? script.trim() : prompt.trim()) &&
    (!scheduleEnabled || cronValid);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onSave({
      ...automation,
      name: name.trim(),
      type,
      prompt: type === "custom" ? prompt.trim() : undefined,
      skillName: type === "skill" ? skillName.trim() : undefined,
      script: type === "shell" ? script.trim() : undefined,
      runTarget,
      schedule: scheduleEnabled ? { cron: cron.trim(), enabled: true } : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">Name</label>
        <input
          type="text"
          className="input input-bordered w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rebase onto main"
          autoFocus
        />
      </div>

      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">Type</label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn btn-sm ${type === "skill" ? "btn-outline btn-primary" : "btn-ghost"}`}
            onClick={() => setType("skill")}
          >
            Claude Code Skill
          </button>
          <button
            type="button"
            className={`btn btn-sm ${type === "custom" ? "btn-outline btn-primary" : "btn-ghost"}`}
            onClick={() => setType("custom")}
          >
            Custom Prompt
          </button>
          <button
            type="button"
            className={`btn btn-sm ${type === "shell" ? "btn-outline btn-primary" : "btn-ghost"}`}
            onClick={() => setType("shell")}
          >
            Shell Script
          </button>
        </div>
      </div>

      {type === "skill" ? (
        <div className="mb-4">
          <label className="block mb-2 text-sm font-medium">Skill</label>
          <select
            className="select select-bordered w-full"
            value={skillName}
            onChange={(e) => {
              setSkillName(e.target.value);
              if (!name.trim()) setName(e.target.value);
            }}
          >
            <option value="">Select a skill...</option>
            {CLAUDE_SKILLS.map((s) => (
              <option key={s} value={s}>
                /{s}
              </option>
            ))}
          </select>
          <p className="text-xs text-base-content/50 mt-1">
            References a Claude Code skill. The skill will be invoked as a slash command.
          </p>
        </div>
      ) : type === "shell" ? (
        <div className="mb-4">
          <label className="block mb-2 text-sm font-medium">Script</label>
          <textarea
            className="textarea textarea-bordered w-full font-mono text-sm"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={10}
            placeholder="#!/bin/sh"
          />
          <p className="text-xs text-base-content/50 mt-1">
            Runs in your shell. <code>$MANY_MAIN_BRANCH</code> and <code>$MANY_REPO_PATH</code>{" "}
            are available, and the script may invoke <code>claude</code>.
          </p>
        </div>
      ) : (
        <div className="mb-4">
          <label className="block mb-2 text-sm font-medium">Prompt</label>
          <textarea
            className="textarea textarea-bordered w-full"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="The prompt to send to Claude Code when this automation is invoked."
          />
        </div>
      )}

      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">Run target</label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn btn-sm ${runTarget === "worktree" ? "btn-outline btn-primary" : "btn-ghost"}`}
            onClick={() => setRunTarget("worktree")}
          >
            Pool worktree
          </button>
          <button
            type="button"
            className={`btn btn-sm ${runTarget === "mainRepo" ? "btn-outline btn-primary" : "btn-ghost"}`}
            onClick={() => setRunTarget("mainRepo")}
          >
            Main repo
          </button>
        </div>
        <p className="text-xs text-base-content/50 mt-1">
          Main repo runs in the repo checkout directly, with no worktree claim.
        </p>
      </div>

      <div className="mb-4">
        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={scheduleEnabled}
            onChange={(e) => setScheduleEnabled(e.target.checked)}
          />
          Run on a schedule
        </label>
        {scheduleEnabled && (
          <div className="mt-2">
            <input
              type="text"
              className="input input-bordered w-full font-mono"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 * * * *"
            />
            <p className="text-xs text-base-content/50 mt-1">
              <code>min hour dom month dow</code> (e.g. <code>0 * * * *</code> = hourly,{" "}
              <code>*/15 * * * *</code> = every 15 min).{" "}
              <span className={cronValid ? "text-success" : "text-error"}>
                {cronValid ? "valid" : "invalid"}
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" className="btn btn-outline btn-neutral" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-outline btn-primary"
          disabled={!isValid}
        >
          Save
        </button>
      </div>
    </form>
  );
};

export default AutomationsModal;
