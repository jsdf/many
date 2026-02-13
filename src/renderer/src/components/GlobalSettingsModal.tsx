import React, { useState, useEffect } from "react";
import { client } from "../main";

interface GlobalSettingsModalProps {
  onClose: () => void;
}

const GlobalSettingsModal: React.FC<GlobalSettingsModalProps> = ({ onClose }) => {
  const [defaultEditor, setDefaultEditor] = useState("");
  const [defaultTerminal, setDefaultTerminal] = useState("");
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
        const settings = await client.getGlobalSettings.query();
        setDefaultEditor(settings.defaultEditor || "");
        setDefaultTerminal(settings.defaultTerminal || "");
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
      await client.saveGlobalSettings.mutate({
        defaultEditor: defaultEditor.trim() || null,
        defaultTerminal: defaultTerminal.trim() || null,
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
    <div className="modal show" onClick={handleBackdropClick}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>Global Settings</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {isLoading ? (
              <p className="text-muted">Loading settings...</p>
            ) : (
              <>
                <div className="form-group">
                  <label htmlFor="default-editor-input">Default Editor:</label>
                  <input
                    type="text"
                    id="default-editor-input"
                    value={defaultEditor}
                    onChange={(e) => setDefaultEditor(e.target.value)}
                    placeholder="e.g. code, cursor, subl"
                    disabled={isSaving}
                  />
                  <p className="form-hint">
                    Command used to open worktrees in an editor. Leave empty to
                    auto-detect.
                  </p>
                </div>
                <div className="form-group">
                  <label htmlFor="default-terminal-input">
                    Default Terminal:
                  </label>
                  <input
                    type="text"
                    id="default-terminal-input"
                    value={defaultTerminal}
                    onChange={(e) => setDefaultTerminal(e.target.value)}
                    placeholder="e.g. Terminal, iTerm, Warp"
                    disabled={isSaving}
                  />
                  <p className="form-hint">
                    Terminal app name (macOS) or command (Linux). Leave empty to
                    use system default.
                  </p>
                </div>
              </>
            )}
            {error && <p className="error-message">{error}</p>}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
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
