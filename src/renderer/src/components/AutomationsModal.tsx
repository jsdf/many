import React, { useState, useEffect } from "react";
import { AutomationDefinition } from "../types";
import { getRpcClient } from "../rpc-client";

interface AutomationsModalProps {
  currentRepo: string;
  onClose: () => void;
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
  onClose,
}) => {
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [editing, setEditing] = useState<AutomationDefinition | null>(null);
  const [loading, setLoading] = useState(true);

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
      type: "custom",
      prompt: "",
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center px-5 py-3 border-b border-base-300 shrink-0">
        <h3 className="text-lg font-semibold m-0">Automations</h3>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onClose}
        >
          &larr; Back
        </button>
      </div>

      <div className="p-5 overflow-y-auto flex-1">
        {editing ? (
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
                  {automations.map((a) => (
                    <div
                      key={a.id}
                      className="bg-base-300 rounded-lg p-4 flex items-start justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{a.name}</div>
                        <div className="text-xs text-base-content/50 mt-1">
                          {a.type === "skill" ? (
                            <span className="badge badge-info badge-xs mr-1">skill</span>
                          ) : (
                            <span className="badge badge-neutral badge-xs mr-1">custom</span>
                          )}
                          {a.type === "skill" ? `/${a.skillName}` : (a.prompt ?? "").slice(0, 80)}
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
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
  const [type, setType] = useState<"custom" | "skill">(automation.type);
  const [prompt, setPrompt] = useState(automation.prompt ?? "");
  const [skillName, setSkillName] = useState(automation.skillName ?? "");

  const isValid = name.trim() && (type === "skill" ? skillName.trim() : prompt.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    onSave({
      ...automation,
      name: name.trim(),
      type,
      prompt: type === "custom" ? prompt.trim() : undefined,
      skillName: type === "skill" ? skillName.trim() : undefined,
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
            className={`btn btn-sm ${type === "skill" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setType("skill")}
          >
            Claude Code Skill
          </button>
          <button
            type="button"
            className={`btn btn-sm ${type === "custom" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setType("custom")}
          >
            Custom Prompt
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

      <div className="flex justify-end gap-3">
        <button type="button" className="btn btn-neutral" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!isValid}
        >
          Save
        </button>
      </div>
    </form>
  );
};

export default AutomationsModal;
