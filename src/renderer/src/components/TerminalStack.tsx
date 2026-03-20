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
    <div className="flex flex-col h-full overflow-hidden" ref={containerRef}>
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-base-200 border-b border-base-300 shrink-0">
        <span className="text-sm text-base-content/60 font-medium">Terminals</span>
        <button className="btn btn-neutral btn-xs" onClick={createTerminal}>
          + New
        </button>
      </div>
      <div
        className="flex-1 flex flex-col overflow-hidden min-h-0"
        style={{ userSelect: dragging !== null ? "none" : undefined }}
      >
        {!hasTerminals && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-base-content/60">
            <p>No terminals open</p>
            <button className="btn btn-neutral" onClick={createTerminal}>
              + New Terminal
            </button>
          </div>
        )}
        {terminals.map((term, i) => (
          <React.Fragment key={term.id}>
            {i > 0 && (
              <div
                className={`h-1 shrink-0 cursor-ns-resize transition-colors ${dragging === i - 1 ? 'bg-primary' : 'bg-base-300 hover:bg-primary'}`}
                onMouseDown={(e) => handleMouseDown(i - 1, e)}
              />
            )}
            <div
              className="flex flex-col overflow-hidden min-h-[60px]"
              style={{
                flex: `${sizes[i] ?? 1 / terminals.length} 0 0`,
                minHeight: 0,
              }}
            >
              <div className="flex items-center justify-between px-2.5 py-[3px] bg-base-300 border-b border-base-300 shrink-0">
                <span className="text-xs text-base-content/60">
                  Terminal {i + 1}
                </span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => closeTerminal(term.id)}
                  title="Close terminal"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-hidden min-h-0">
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
