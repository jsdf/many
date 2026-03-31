import React, { useState, useEffect } from "react";
import { AutomationDefinition, PoolConfig } from "../types";
import { getRpcClient } from "../rpc-client";

interface AutomationsModalProps {
  currentRepo: string;
  pools: PoolConfig[];
  onClose: () => void;
  onStartRun: (automationId: string, manualWorkItems?: string[]) => void;
}

function generateId(): string {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const AutomationsModal: React.FC<AutomationsModalProps> = ({
  currentRepo,
  pools,
  onClose,
  onStartRun,
}) => {
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [manualRunTarget, setManualRunTarget] = useState<AutomationDefinition | null>(null);
  const [manualPrompts, setManualPrompts] = useState("");
  const [loading, setLoading] = useState(true);

  const taskPools = pools.filter((p) => p.taskCommand || p.backgroundTaskCommand);

  useEffect(() => {
    loadAutomations();
  }, [currentRepo]);

  const loadAutomations = async () => {
    try {
      const result = await getRpcClient().query("automation.list", { repoPath: currentRepo });
      setAutomations(result as AutomationDefinition[]);
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

  const handleNew = () => {
    setEditing({
      id: generateId(),
      name: "",
      poolPrefix: taskPools[0]?.prefix ?? "",
      producerPrompt: "",
      concurrency: 2,
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[700px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Automations</h3>
          <button
            className="btn btn-ghost btn-sm btn-circle text-base-content/60"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="p-5">
          {editing ? (
            <AutomationForm
              automation={editing}
              pools={taskPools}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
            />
          ) : manualRunTarget ? (
            <div>
              <h4 className="font-semibold mb-2">
                Manual Run: {manualRunTarget.name}
              </h4>
              <p className="text-xs text-base-content/50 mb-2">
                Pool: {manualRunTarget.poolPrefix} &middot; Concurrency: {manualRunTarget.concurrency}
              </p>
              <label className="block mb-2 text-sm font-medium">
                Work items (one prompt per line)
              </label>
              <textarea
                className="textarea textarea-bordered w-full"
                value={manualPrompts}
                onChange={(e) => setManualPrompts(e.target.value)}
                rows={8}
                placeholder={"implement user auth\nadd search API\nwrite tests for billing"}
                autoFocus
              />
              <div className="flex justify-end gap-3 mt-4">
                <button
                  className="btn btn-neutral"
                  onClick={() => {
                    setManualRunTarget(null);
                    setManualPrompts("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-success"
                  disabled={!manualPrompts.trim()}
                  onClick={() => {
                    const items = manualPrompts
                      .split("\n")
                      .map((l) => l.trim())
                      .filter((l) => l.length > 0);
                    if (items.length > 0) {
                      onStartRun(manualRunTarget.id, items);
                    }
                  }}
                >
                  Start ({manualPrompts.split("\n").filter((l) => l.trim()).length} items)
                </button>
              </div>
            </div>
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
                  {automations.map((a) => (
                    <div
                      key={a.id}
                      className="bg-base-300 rounded-lg p-4 flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{a.name}</div>
                        <div className="text-xs text-base-content/50 mt-1">
                          Pool: {a.poolPrefix} &middot; Concurrency: {a.concurrency}
                        </div>
                        <div className="text-xs text-base-content/60 mt-1 line-clamp-2">
                          {a.producerPrompt}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() => onStartRun(a.id)}
                          title="Run with producer"
                        >
                          Run
                        </button>
                        <button
                          className="btn btn-info btn-sm"
                          onClick={() => setManualRunTarget(a)}
                          title="Manually enter work items"
                        >
                          Manual
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
                  ))}
                </div>
              )}

              <div className="mt-4">
                <button className="btn btn-primary w-full" onClick={handleNew}>
                  New Automation
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Form sub-component ---

interface AutomationFormProps {
  automation: AutomationDefinition;
  pools: PoolConfig[];
  onSave: (automation: AutomationDefinition) => void;
  onCancel: () => void;
}

const AutomationForm: React.FC<AutomationFormProps> = ({
  automation,
  pools,
  onSave,
  onCancel,
}) => {
  const [name, setName] = useState(automation.name);
  const [poolPrefix, setPoolPrefix] = useState(automation.poolPrefix);
  const [producerPrompt, setProducerPrompt] = useState(automation.producerPrompt);
  const [concurrency, setConcurrency] = useState(automation.concurrency);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !producerPrompt.trim()) return;
    onSave({
      ...automation,
      name: name.trim(),
      poolPrefix,
      producerPrompt: producerPrompt.trim(),
      concurrency: Math.max(1, concurrency),
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
          placeholder="e.g. Implement feature list"
          autoFocus
        />
      </div>

      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">Pool</label>
        <select
          className="select select-bordered w-full"
          value={poolPrefix}
          onChange={(e) => setPoolPrefix(e.target.value)}
        >
          {pools.map((p) => (
            <option key={p.prefix} value={p.prefix}>
              {p.name} ({p.type})
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">Producer Prompt</label>
        <textarea
          className="textarea textarea-bordered w-full"
          value={producerPrompt}
          onChange={(e) => setProducerPrompt(e.target.value)}
          rows={8}
          placeholder={`The producer task will run with this prompt. It must write a JSON array of work item prompts to .many-work-items.json in the worktree root.\n\nExample output file:\n["implement user auth", "add search API", "write tests for billing"]`}
        />
        <p className="text-xs text-base-content/50 mt-1">
          The producer must write a <code>.many-work-items.json</code> file
          containing a JSON array of prompt strings.
        </p>
      </div>

      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">
          Concurrency (max workers)
        </label>
        <input
          type="number"
          className="input input-bordered w-24"
          value={concurrency}
          onChange={(e) => setConcurrency(parseInt(e.target.value) || 1)}
          min={1}
          max={20}
        />
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" className="btn btn-neutral" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!name.trim() || !producerPrompt.trim()}
        >
          Save
        </button>
      </div>
    </form>
  );
};

export default AutomationsModal;
