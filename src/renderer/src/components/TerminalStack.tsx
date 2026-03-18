import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { client } from "../main";
import TerminalTab from "./TerminalTab";

interface TerminalStackProps {
  worktreePath: string;
}

export interface TerminalStackHandle {
  createTerminalWithCommand: (env: Record<string, string>, initialCommand: string) => void;
}

interface TerminalInfo {
  id: string;
  env?: Record<string, string>;
  initialCommand?: string;
}

let terminalCounter = 0;

const TerminalStack = forwardRef<TerminalStackHandle, TerminalStackProps>(({ worktreePath }, ref) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [sizes, setSizes] = useState<number[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load existing sessions on mount
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
          setSizes(existingIds.map(() => 1 / existingIds.length));
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

  const addTerminal = useCallback((env?: Record<string, string>, initialCommand?: string) => {
    terminalCounter++;
    const id = `${worktreePath}-term-${Date.now()}-${terminalCounter}`;
    setTerminals((prev) => {
      const next = [...prev, { id, env, initialCommand }];
      setSizes(next.map(() => 1 / next.length));
      return next;
    });
  }, [worktreePath]);

  const createTerminal = useCallback(() => {
    addTerminal();
  }, [addTerminal]);

  useImperativeHandle(ref, () => ({
    createTerminalWithCommand: (env: Record<string, string>, initialCommand: string) => {
      addTerminal(env, initialCommand);
    },
  }), [addTerminal]);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      try {
        await client.closeTerminal.mutate({ terminalId });
      } catch (err) {
        // Session may already be dead
      }
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== terminalId);
        if (next.length > 0) {
          setSizes(next.map(() => 1 / next.length));
        } else {
          setSizes([]);
        }
        return next;
      });
    },
    []
  );

  const handleMouseDown = useCallback(
    (dividerIndex: number, e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(dividerIndex);
    },
    []
  );

  useEffect(() => {
    if (dragging === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const totalHeight = rect.height;
      const relY = e.clientY - rect.top;
      const fraction = relY / totalHeight;

      setSizes((prev) => {
        const next = [...prev];
        let sumBefore = 0;
        for (let i = 0; i <= dragging; i++) sumBefore += next[i];
        const pairSize = next[dragging] + next[dragging + 1];
        const pairStart = sumBefore - next[dragging];

        const minSize = 0.05;
        let newTop = fraction - pairStart;
        newTop = Math.max(minSize, Math.min(pairSize - minSize, newTop));

        next[dragging] = newTop;
        next[dragging + 1] = pairSize - newTop;
        return next;
      });
    };

    const handleMouseUp = () => {
      setDragging(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  const hasTerminals = terminals.length > 0;

  return (
    <div className="terminal-stack" ref={containerRef}>
      <div className="terminal-stack-header">
        <span className="terminal-stack-label">Terminals</span>
        <button className="btn btn-sm btn-secondary" onClick={createTerminal}>
          + New
        </button>
      </div>
      <div
        className="terminal-stack-body"
        style={{ userSelect: dragging !== null ? "none" : undefined }}
      >
        {!hasTerminals && (
          <div className="terminal-stack-empty">
            <p>No terminals open</p>
            <button className="btn btn-secondary" onClick={createTerminal}>
              + New Terminal
            </button>
          </div>
        )}
        {terminals.map((term, i) => (
          <React.Fragment key={term.id}>
            {i > 0 && (
              <div
                className={`terminal-stack-divider ${dragging === i - 1 ? "active" : ""}`}
                onMouseDown={(e) => handleMouseDown(i - 1, e)}
              />
            )}
            <div
              className="terminal-stack-pane"
              style={{
                flex: `${sizes[i] ?? 1 / terminals.length} 0 0`,
                minHeight: 0,
              }}
            >
              <div className="terminal-stack-pane-header">
                <span className="terminal-stack-pane-title">
                  Terminal {i + 1}
                </span>
                <button
                  className="terminal-tab-close"
                  onClick={() => closeTerminal(term.id)}
                  title="Close terminal"
                >
                  ×
                </button>
              </div>
              <div className="terminal-stack-pane-body">
                <TerminalTab
                  terminalId={term.id}
                  worktreePath={worktreePath}
                  isVisible={true}
                  env={term.env}
                  initialCommand={term.initialCommand}
                />
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
});

export default TerminalStack;
