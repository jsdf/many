import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Worktree, PoolConfig, formatBranchName, findWorktreePool } from "../types";
import WelcomeScreen from "./WelcomeScreen";
import WorktreeDetails from "./WorktreeDetails";
import TerminalStack, { TerminalStackHandle } from "./TerminalStack";

interface MainContentProps {
  selectedWorktree: Worktree | null;
  currentRepo: string | null;
  pools?: PoolConfig[];
  onArchiveWorktree: (worktree: Worktree) => Promise<void>;
  onMergeWorktree: (worktree: Worktree) => void;
  onRebaseWorktree: (worktree: Worktree) => void;
  onReleaseWorktree?: (worktree: Worktree) => void;
}

export interface MainContentHandle {
  launchTaskTerminal: (env: Record<string, string>, initialCommand: string) => void;
}

const MIN_PANE_WIDTH = 200;
const DEFAULT_SPLIT = 0.5;

const MainContent = forwardRef<MainContentHandle, MainContentProps>(({
  selectedWorktree,
  currentRepo,
  pools,
  onArchiveWorktree,
  onMergeWorktree,
  onRebaseWorktree,
  onReleaseWorktree,
}, ref) => {
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalStackRef = useRef<TerminalStackHandle>(null);

  useImperativeHandle(ref, () => ({
    launchTaskTerminal: (env: Record<string, string>, initialCommand: string) => {
      terminalStackRef.current?.createTerminalWithCommand(env, initialCommand);
    },
  }), []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const totalWidth = rect.width;
      const relX = e.clientX - rect.left;
      const fraction = relX / totalWidth;
      const minFraction = MIN_PANE_WIDTH / totalWidth;
      setSplitFraction(
        Math.max(minFraction, Math.min(1 - minFraction, fraction))
      );
    };

    const handleMouseUp = () => setDragging(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  const worktreePool = selectedWorktree ? findWorktreePool(selectedWorktree, pools) : null;
  const showRelease = worktreePool ? worktreePool.type === 'recyclable' : true;
  const showArchive = !(worktreePool?.type === 'recyclable');

  if (!selectedWorktree) {
    return <WelcomeScreen />;
  }

  return (
    <div className="flex flex-col p-0 h-screen w-full min-w-0 items-stretch justify-start flex-1">
      <div className="flex justify-between items-center px-5 py-3 bg-base-200 border-b border-base-300 shrink-0">
        <div>
          <h2 className="m-0 text-base font-semibold">{formatBranchName(selectedWorktree.branch)}</h2>
          <span className="block text-xs text-base-content/50 mt-0.5" title={selectedWorktree.path}>{selectedWorktree.worktreeName}</span>
        </div>
      </div>

      <div
        className="flex-1 flex overflow-hidden min-h-0"
        ref={containerRef}
        style={{ userSelect: dragging ? "none" : undefined }}
      >
        <div
          className="overflow-y-auto min-w-[200px]"
          style={{ flex: `0 0 ${splitFraction * 100}%` }}
        >
          <WorktreeDetails
            key={`worktree-details-${selectedWorktree.path}`}
            worktree={selectedWorktree}
            repoPath={currentRepo!}
            onArchiveWorktree={showArchive ? onArchiveWorktree : undefined}
            onMergeWorktree={onMergeWorktree}
            onRebaseWorktree={onRebaseWorktree}
            onReleaseWorktree={showRelease ? onReleaseWorktree : undefined}
          />
        </div>

        <div
          className={`w-1 shrink-0 bg-base-300 cursor-ew-resize transition-colors ${dragging ? 'bg-primary' : 'hover:bg-primary'}`}
          onMouseDown={handleMouseDown}
        />

        <div className="flex-1 min-w-[200px] flex flex-col overflow-hidden">
          {selectedWorktree.path && (
            <TerminalStack
              key={`terminal-stack-${selectedWorktree.path}`}
              ref={terminalStackRef}
              worktreePath={selectedWorktree.path}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default MainContent;
