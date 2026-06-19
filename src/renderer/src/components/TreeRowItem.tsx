import React from "react";
import { ChevronDown, ChevronRight, Folder, File, Terminal } from "lucide-react";

export interface TreeRowItemProps {
  name: string;
  isDirectory: boolean;
  isProject: boolean;
  depth: number;
  selected: boolean;
  expanded: boolean;
  loading?: boolean;
  dimmed?: boolean;
  title?: string;
  terminalCount?: number;
  onClick: () => void;
  // Caret click handler. When omitted, clicking the caret falls through to
  // onClick (used by the curated active-sessions tree, which is always open).
  onToggleCaret?: (e: React.MouseEvent) => void;
  rightSlot?: React.ReactNode;
}

// One row of a folder tree: caret, icon, name, optional terminal-count badge.
// Shared by the browsable Projects tree and the Active Sessions tree.
const TreeRowItem: React.FC<TreeRowItemProps> = ({
  name,
  isDirectory,
  isProject,
  depth,
  selected,
  expanded,
  loading,
  dimmed,
  title,
  terminalCount,
  onClick,
  onToggleCaret,
  rightSlot,
}) => (
  <div className={`flex items-center w-full h-full rounded ${selected ? "bg-primary/15" : "hover:bg-base-300/60"}`}>
    <div
      role="button"
      className={`flex items-center flex-1 min-w-0 h-full text-left whitespace-nowrap px-1 cursor-pointer ${isProject ? "text-xs font-semibold" : "text-xs"} ${selected ? "text-primary" : ""}`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      title={title}
      onClick={onClick}
    >
      <span
        className="inline-flex items-center justify-center w-3 shrink-0 text-base-content/50"
        onClick={isDirectory && onToggleCaret ? onToggleCaret : undefined}
      >
        {isDirectory ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
      </span>
      <span className="shrink-0 inline-flex items-center text-base-content/60">{isDirectory ? <Folder size={14} /> : <File size={14} />}</span>
      <span className={`ml-1 truncate ${dimmed ? "text-base-content/50" : ""}`}>{name}</span>
      {loading && <span className="loading loading-spinner loading-xs ml-1" />}
    </div>
    {terminalCount ? (
      <span
        className="text-[10px] text-base-content/60 shrink-0 px-1 inline-flex items-center gap-0.5"
        title={`${terminalCount} terminal${terminalCount > 1 ? "s" : ""}`}
      >
        <Terminal size={10} /> {terminalCount}
      </span>
    ) : null}
    {rightSlot}
  </div>
);

export default TreeRowItem;
