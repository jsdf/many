import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Menu } from '@base-ui-components/react/menu'
import { getMuxSteps, addMuxStep, updateMuxStep, deleteMuxStep, type TrackedStep } from '../mux-client'
import { AutomationDefinition } from '../types'
import { getRpcClient } from '../rpc-client'
import { Play, X } from 'lucide-react'

const AUTOMATION_PREFIX = '[[automation:';
const AUTOMATION_SUFFIX = ']]';

interface AutomationStepData {
  automationId: string;
  automationName: string;
  prompt?: string;
}

function encodeAutomationStep(data: AutomationStepData): string {
  return AUTOMATION_PREFIX + JSON.stringify(data) + AUTOMATION_SUFFIX;
}

function decodeAutomationStep(text: string): AutomationStepData | null {
  if (!text.startsWith(AUTOMATION_PREFIX) || !text.endsWith(AUTOMATION_SUFFIX)) return null;
  try {
    return JSON.parse(text.slice(AUTOMATION_PREFIX.length, -AUTOMATION_SUFFIX.length));
  } catch {
    return null;
  }
}

type Step = TrackedStep;

const TrackedSteps: React.FC<{
  repoPath: string
  branch: string
}> = ({ repoPath, branch }) => {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const load = useCallback(async () => {
    try {
      const result = await getMuxSteps(repoPath, branch);
      setSteps(result);
    } catch {
      setSteps([]);
    }
    setLoaded(true);
  }, [repoPath, branch]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getRpcClient().query("automation.list", { repoPath })
      .then((result) => setAutomations(result as AutomationDefinition[]))
      .catch(() => {});
  }, [repoPath]);

  const addTextStep = async () => {
    try {
      const id = await addMuxStep(repoPath, branch, "");
      if (id) {
        setSteps((prev) => [...prev, { id, type: "text", data: { text: "" }, completed: false }]);
      }
    } catch (err) {
      console.error("Failed to add step:", err);
    }
  };

  const addAutomationStep = async (automation: AutomationDefinition) => {
    const data: AutomationStepData = {
      automationId: automation.id,
      automationName: automation.name,
    };
    const encoded = encodeAutomationStep(data);
    try {
      const id = await addMuxStep(repoPath, branch, encoded);
      if (id) {
        setSteps((prev) => [...prev, { id, type: "text", data: { text: encoded }, completed: false }]);
      }
    } catch (err) {
      console.error("Failed to add automation step:", err);
    }
  };

  const removeStep = async (id: string) => {
    setSteps((prev) => prev.filter((s) => s.id !== id));
    try {
      await deleteMuxStep(id);
    } catch {
      load();
    }
  };

  const toggleCompleted = async (step: Step) => {
    const next = !step.completed;
    setSteps((prev) => prev.map((s) => s.id === step.id ? { ...s, completed: next } : s));
    try {
      await updateMuxStep(step.id, undefined, next);
    } catch {
      load();
    }
  };

  const updateText = (step: Step, text: string) => {
    setSteps((prev) => prev.map((s) => s.id === step.id ? { ...s, data: { ...s.data, text } } : s));

    const existing = saveTimers.current.get(step.id);
    if (existing) clearTimeout(existing);
    saveTimers.current.set(step.id, setTimeout(() => {
      updateMuxStep(step.id, text, step.completed).catch(() => {});
      saveTimers.current.delete(step.id);
    }, 500));
  };

  const updateAutomationPrompt = async (step: Step, prompt: string) => {
    const autoData = decodeAutomationStep((step.data.text as string) ?? "");
    if (!autoData) return;
    autoData.prompt = prompt || undefined;
    const encoded = encodeAutomationStep(autoData);
    setSteps((prev) => prev.map((s) => s.id === step.id ? { ...s, data: { ...s.data, text: encoded } } : s));
    try {
      await updateMuxStep(step.id, encoded, step.completed);
    } catch {
      load();
    }
  };

  const runAutomationStep = async (step: Step) => {
    const autoData = decodeAutomationStep((step.data.text as string) ?? "");
    if (!autoData) return;

    const automation = automations.find((a) => a.id === autoData.automationId);
    if (!automation) {
      console.error("Automation not found:", autoData.automationId);
      return;
    }

    let prompt: string;
    if (automation.type === "skill") {
      prompt = `/${automation.skillName}`;
      if (autoData.prompt) prompt += ` ${autoData.prompt}`;
    } else {
      prompt = automation.prompt ?? "";
      if (autoData.prompt) prompt += `\n\n${autoData.prompt}`;
    }

    // Find the worktree for this branch to launch the task
    try {
      const worktrees = await getRpcClient().query("worktree.list", { repoPath });
      const wt = worktrees.find((w: any) =>
        w.branch === branch || w.branch === `refs/heads/${branch}`
      );
      if (!wt) {
        console.error("No worktree found for branch:", branch);
        return;
      }

      // Use stream.launchTask to run it
      const repoConfig = await getRpcClient().query("repo.getConfig", { repoPath });
      const pool = repoConfig.pools?.find((p: any) => p.taskCommand || p.backgroundTaskCommand);
      if (!pool) {
        console.error("No task pool configured");
        return;
      }

      getRpcClient().subscribe(
        "stream.launchTask",
        () => {},
        {
          repoPath,
          poolType: pool.type,
          poolPrefix: pool.prefix,
          prompt,
          taskCommand: pool.backgroundTaskCommand || pool.taskCommand,
        }
      );
    } catch (err) {
      console.error("Failed to run automation step:", err);
    }
  };

  if (!loaded) return null;

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-base-content/50 uppercase">Steps</span>
        <Menu.Root>
          <Menu.Trigger className="btn btn-xs btn-ghost text-base-content/50">
            + Add
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="z-50" sideOffset={4}>
              <Menu.Popup className="bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 min-w-36">
                <Menu.Item
                  className="px-3 py-1.5 text-sm cursor-pointer hover:bg-base-200 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary"
                  onClick={() => addTextStep()}
                >
                  Text
                </Menu.Item>
                {automations.length > 0 && (
                  <>
                    <div className="border-t border-base-300 my-1" />
                    <div className="px-3 py-1 text-[10px] uppercase text-base-content/40 font-semibold">Automations</div>
                    {automations.map((a) => (
                      <Menu.Item
                        key={a.id}
                        className="px-3 py-1.5 text-sm cursor-pointer hover:bg-base-200 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary"
                        onClick={() => addAutomationStep(a)}
                      >
                        {a.type === "skill" ? `/${a.skillName}` : a.name}
                      </Menu.Item>
                    ))}
                  </>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {steps.length === 0 ? (
        <p className="text-xs text-base-content/40 italic">No steps yet</p>
      ) : (
        <div className="flex flex-col gap-1">
          {steps.map((step) => {
            const text = (step.data.text as string) ?? '';
            const autoData = decodeAutomationStep(text);

            if (autoData) {
              return (
                <div key={step.id} className="flex items-start gap-2 group">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs checkbox-primary mt-1.5"
                    checked={step.completed}
                    onChange={() => toggleCompleted(step)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="badge badge-info badge-xs">auto</span>
                      <span className={`text-sm font-medium ${step.completed ? 'line-through text-base-content/40' : ''}`}>
                        {autoData.automationName}
                      </span>
                    </div>
                    {editingPrompt === step.id ? (
                      <div className="mt-1 flex gap-1">
                        <input
                          type="text"
                          className="input input-xs input-bordered flex-1 bg-base-200 text-sm"
                          value={promptValue}
                          onChange={(e) => setPromptValue(e.target.value)}
                          placeholder="Additional context..."
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              updateAutomationPrompt(step, promptValue);
                              setEditingPrompt(null);
                            } else if (e.key === "Escape") {
                              setEditingPrompt(null);
                            }
                          }}
                        />
                        <button
                          className="btn btn-xs btn-ghost"
                          onClick={() => {
                            updateAutomationPrompt(step, promptValue);
                            setEditingPrompt(null);
                          }}
                        >
                          OK
                        </button>
                      </div>
                    ) : autoData.prompt ? (
                      <div
                        className="text-xs text-base-content/50 mt-0.5 cursor-pointer hover:text-base-content/70"
                        onClick={() => {
                          setEditingPrompt(step.id);
                          setPromptValue(autoData.prompt ?? "");
                        }}
                      >
                        {autoData.prompt}
                      </div>
                    ) : (
                      <button
                        className="text-[10px] text-base-content/30 hover:text-base-content/50 mt-0.5"
                        onClick={() => {
                          setEditingPrompt(step.id);
                          setPromptValue("");
                        }}
                      >
                        + add context
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {!step.completed && (
                      <button
                        className="btn btn-xs btn-success btn-ghost opacity-0 group-hover:opacity-100"
                        title="Run"
                        onClick={() => runAutomationStep(step)}
                      >
                        <Play size={12} />
                      </button>
                    )}
                    <button
                      className="text-xs text-base-content/30 hover:text-error opacity-0 group-hover:opacity-100 px-0.5 mt-0.5"
                      title="Remove step"
                      onClick={() => removeStep(step.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={step.id} className="flex items-start gap-2 group">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs checkbox-primary mt-1.5"
                  checked={step.completed}
                  onChange={() => toggleCompleted(step)}
                />
                <input
                  type="text"
                  className={`input input-xs input-bordered flex-1 bg-base-200 text-sm ${step.completed ? 'line-through text-base-content/40' : ''}`}
                  value={text}
                  onChange={(e) => updateText(step, e.target.value)}
                  placeholder="Step description..."
                />
                <button
                  className="text-xs text-base-content/30 hover:text-error opacity-0 group-hover:opacity-100 px-0.5 mt-0.5"
                  title="Remove step"
                  onClick={() => removeStep(step.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TrackedSteps;
