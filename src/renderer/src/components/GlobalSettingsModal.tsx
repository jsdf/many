import React, { useState, useEffect } from "react";
import { getRpcClient } from "../rpc-client";

interface GlobalSettingsModalProps {
  onClose: () => void;
  onAddRepo: () => void;
}

const GlobalSettingsModal: React.FC<GlobalSettingsModalProps> = ({ onClose, onAddRepo }) => {
  const [defaultEditor, setDefaultEditor] = useState("");
  const [defaultTerminal, setDefaultTerminal] = useState("");
  const [defaultClaudeCommand, setDefaultClaudeCommand] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const loadSettings = async () => {
      setIsLoading(true);
      try {
        const settings = await getRpcClient().query("settings.get", {});
        setDefaultEditor(settings.defaultEditor || "");
        setDefaultTerminal(settings.defaultTerminal || "");
        setDefaultClaudeCommand(settings.defaultClaudeCommand || "");
      } catch (err) {
        console.error("Failed to load global settings:", err);
        setError("Failed to load settings");
      } finally {
        setIsLoading(false);
      }
    };

    loadSettings();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      await getRpcClient().query("settings.save", {
        defaultEditor: defaultEditor.trim() || null,
        defaultTerminal: defaultTerminal.trim() || null,
        defaultClaudeCommand: defaultClaudeCommand.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save settings"
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-base-200 border border-base-300 rounded-xl w-[90%] max-w-[500px] max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-5 border-b border-base-300">
          <h3 className="text-lg font-semibold m-0">Global Settings</h3>
          <button className="btn btn-ghost btn-sm btn-circle text-base-content/60" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-5">
            {isLoading ? (
              <p className="text-base-content/60 italic">Loading settings...</p>
            ) : (
              <>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="default-editor-input">Default Editor:</label>
                  <input
                    type="text"
                    id="default-editor-input"
                    className="input input-bordered w-full"
                    value={defaultEditor}
                    onChange={(e) => setDefaultEditor(e.target.value)}
                    placeholder="e.g. code, cursor, subl"
                    disabled={isSaving}
                  />
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Command used to open worktrees in an editor. Leave empty to auto-detect.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="default-terminal-input">
                    Default Terminal:
                  </label>
                  <input
                    type="text"
                    id="default-terminal-input"
                    className="input input-bordered w-full"
                    value={defaultTerminal}
                    onChange={(e) => setDefaultTerminal(e.target.value)}
                    placeholder="e.g. Terminal, iTerm, Warp"
                    disabled={isSaving}
                  />
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Terminal app name (macOS) or command (Linux). Leave empty to use system default.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="block mb-2 text-sm font-medium" htmlFor="default-claude-command-input">
                    Default Claude Code Command:
                  </label>
                  <input
                    type="text"
                    id="default-claude-command-input"
                    className="input input-bordered w-full"
                    value={defaultClaudeCommand}
                    onChange={(e) => setDefaultClaudeCommand(e.target.value)}
                    placeholder="e.g. claude, claude --dangerously-skip-permissions"
                    disabled={isSaving}
                  />
                  <p className="text-xs text-base-content/50 mt-1.5">
                    Command used to launch Claude Code from the projects page. Leave empty to use "claude".
                  </p>
                </div>
              </>
            )}
            {error && <p className="text-error text-sm mt-2 p-2 bg-error/10 rounded">{error}</p>}

                <div className="mb-0 pt-2 border-t border-base-300">
                  <label className="block mb-2 text-sm font-medium">Repositories:</label>
                  <button
                    type="button"
                    className="btn btn-outline btn-neutral btn-sm"
                    onClick={() => { onClose(); onAddRepo(); }}
                  >
                    + Add Repo
                  </button>
                </div>
          </div>
          <div className="flex justify-end gap-3 p-5 border-t border-base-300">
            <button
              type="button"
              className="btn btn-outline btn-neutral"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-outline btn-primary"
              disabled={isSaving || isLoading}
            >
              {isSaving ? "Saving..." : "Save Settings"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default GlobalSettingsModal;
