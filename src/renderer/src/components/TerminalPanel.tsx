import React, { useState, useEffect, useCallback } from "react";
import { getRpcClient } from "../rpc-client";
import TerminalTab from "./TerminalTab";
import { ChevronRight, ChevronDown, X } from "lucide-react";

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

  useEffect(() => {
    let cancelled = false;

    const loadExisting = async () => {
      try {
        const existingIds = await getRpcClient().query("terminal.listSessions", {
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
        await getRpcClient().query("terminal.close", { terminalId });
      } catch (err) {
        // Session may already be dead
      }
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== terminalId);
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
    <div className="mt-5 border border-base-300 rounded-lg overflow-hidden">
      <div className="bg-base-200 border-b border-base-300">
        <div className="flex items-center justify-between px-2.5 py-1.5">
          {hasTerminals && (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => setIsCollapsed(!isCollapsed)}
              title={isCollapsed ? "Expand terminal" : "Collapse terminal"}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />} Terminal
            </button>
          )}
          {!hasTerminals && <span className="text-sm text-base-content/60">Terminal</span>}
          <button className="btn btn-soft btn-neutral btn-xs" onClick={createTerminal}>
            + New Terminal
          </button>
        </div>

        {hasTerminals && !isCollapsed && (
          <div className="flex gap-0 px-2.5 border-t border-base-300">
            {terminals.map((term, i) => (
              <div
                key={term.id}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-b-2 select-none ${
                  activeTerminalId === term.id
                    ? 'text-base-content border-b-primary'
                    : 'text-base-content/60 border-b-transparent hover:text-base-content/80 hover:bg-base-300'
                }`}
                onClick={() => setActiveTerminalId(term.id)}
              >
                <span className="whitespace-nowrap">Terminal {i + 1}</span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(term.id);
                  }}
                  title="Close terminal"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {hasTerminals && !isCollapsed && (
        <div className="h-[350px] bg-base-100">
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
