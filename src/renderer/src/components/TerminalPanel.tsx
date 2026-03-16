import React, { useState, useEffect, useCallback } from "react";
import { client } from "../main";
import TerminalTab from "./TerminalTab";

interface TerminalPanelProps {
  worktreePath: string;
}

interface TerminalInfo {
  id: string;
}

let terminalCounter = 0;

const TerminalPanel: React.FC<TerminalPanelProps> = ({ worktreePath }) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // On mount, check for existing server-side sessions for this worktree
  useEffect(() => {
    let cancelled = false;

    const loadExisting = async () => {
      try {
        const existingIds = await client.getTerminalSessions.query({
          worktreePath,
        });
        if (cancelled) return;

        if (existingIds.length > 0) {
          const terminalInfos = existingIds.map((id) => ({ id }));
          setTerminals(terminalInfos);
          setActiveTerminalId(existingIds[0]);
          setIsCollapsed(false);
        }
      } catch (err) {
        console.error("Failed to load terminal sessions:", err);
      }
    };

    loadExisting();
    return () => {
      cancelled = true;
    };
  }, [worktreePath]);

  const createTerminal = useCallback(() => {
    terminalCounter++;
    const id = `${worktreePath}-term-${Date.now()}-${terminalCounter}`;
    setTerminals((prev) => [...prev, { id }]);
    setActiveTerminalId(id);
    setIsCollapsed(false);
  }, [worktreePath]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      try {
        await client.closeTerminal.mutate({ terminalId });
      } catch (err) {
        // Session may already be dead
      }
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== terminalId);
        // If we closed the active tab, switch to another
        if (activeTerminalId === terminalId) {
          setActiveTerminalId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
    },
    [activeTerminalId]
  );

  const hasTerminals = terminals.length > 0;

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <div className="terminal-panel-title-row">
          {hasTerminals && (
            <button
              className="btn btn-sm"
              onClick={() => setIsCollapsed(!isCollapsed)}
              title={isCollapsed ? "Expand terminal" : "Collapse terminal"}
            >
              {isCollapsed ? "▶" : "▼"} Terminal
            </button>
          )}
          {!hasTerminals && <span className="terminal-panel-label">Terminal</span>}
          <button className="btn btn-sm btn-secondary" onClick={createTerminal}>
            + New Terminal
          </button>
        </div>

        {hasTerminals && !isCollapsed && (
          <div className="terminal-tabs">
            {terminals.map((term, i) => (
              <div
                key={term.id}
                className={`terminal-tab ${
                  activeTerminalId === term.id ? "active" : ""
                }`}
                onClick={() => setActiveTerminalId(term.id)}
              >
                <span className="terminal-tab-name">Terminal {i + 1}</span>
                <button
                  className="terminal-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(term.id);
                  }}
                  title="Close terminal"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {hasTerminals && !isCollapsed && (
        <div className="terminal-panel-body">
          {terminals.map((term) => (
            <TerminalTab
              key={term.id}
              terminalId={term.id}
              worktreePath={worktreePath}
              isVisible={activeTerminalId === term.id}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default TerminalPanel;
