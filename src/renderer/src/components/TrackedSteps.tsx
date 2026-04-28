import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Menu } from '@base-ui-components/react/menu'
import { getMuxSteps, addMuxStep, updateMuxStep, deleteMuxStep, type TrackedStep } from '../mux-client'

const STEP_TYPES = [
  { type: 'text', label: 'Text', defaultData: { text: '' } },
] as const;

type Step = TrackedStep;

const TrackedSteps: React.FC<{
  repoPath: string
  branch: string
}> = ({ repoPath, branch }) => {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loaded, setLoaded] = useState(false);
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

  const addStep = async (_type: string, defaultData: Record<string, unknown>) => {
    try {
      const id = await addMuxStep(repoPath, branch, (defaultData.text as string) ?? "");
      if (id) {
        setSteps((prev) => [...prev, { id, type: "text", data: { ...defaultData }, completed: false }]);
      }
    } catch (err) {
      console.error("Failed to add step:", err);
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
              <Menu.Popup className="bg-base-100 border border-base-300 rounded-lg shadow-lg py-1 min-w-28">
                {STEP_TYPES.map((st) => (
                  <Menu.Item
                    key={st.type}
                    className="px-3 py-1.5 text-sm cursor-pointer hover:bg-base-200 data-[highlighted]:bg-primary/15 data-[highlighted]:text-primary"
                    onClick={() => addStep(st.type, { ...st.defaultData })}
                  >
                    {st.label}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {steps.length === 0 ? (
        <p className="text-xs text-base-content/40 italic">No steps yet</p>
      ) : (
        <div className="flex flex-col gap-1">
          {steps.map((step) => (
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
                value={(step.data.text as string) ?? ''}
                onChange={(e) => updateText(step, e.target.value)}
                placeholder="Step description..."
              />
              <button
                className="text-xs text-base-content/30 hover:text-error opacity-0 group-hover:opacity-100 px-0.5 mt-0.5"
                title="Remove step"
                onClick={() => removeStep(step.id)}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TrackedSteps;
