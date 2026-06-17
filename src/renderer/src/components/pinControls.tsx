import React from "react";
import { ContextMenuItem } from "./ContextMenu";

// Hover-revealed pin toggle for a directory row. Stays visible (in primary
// color) while the folder is pinned.
export const PinToggle: React.FC<{ pinned: boolean; onToggle: () => void }> = ({
  pinned,
  onToggle,
}) => (
  <button
    className={`px-1.5 shrink-0 ${
      pinned
        ? "text-primary"
        : "opacity-0 group-hover/row:opacity-100 text-base-content/40 hover:text-primary"
    }`}
    title={pinned ? "Unpin from Active" : "Pin to Active"}
    onClick={(e) => {
      e.stopPropagation();
      onToggle();
    }}
  >
    📌
  </button>
);

export function pinMenuItem(pinned: boolean, onToggle: () => void): ContextMenuItem {
  return { label: pinned ? "Unpin from Active" : "Pin to Active", onClick: onToggle };
}
