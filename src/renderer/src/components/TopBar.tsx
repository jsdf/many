import React, { useState } from "react";
import { Menu, ArrowLeft, ArrowRight } from "lucide-react";
import { useNav } from "../nav-context";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import type { NavHistoryEntry } from "../router";

interface TopBarProps {
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  children: React.ReactNode;
}

export default function TopBar({ sidebarCollapsed, onExpandSidebar, children }: TopBarProps) {
  const nav = useNav();
  const [historyMenu, setHistoryMenu] = useState<
    { x: number; y: number; entries: NavHistoryEntry[] } | null
  >(null);

  const openHistoryMenu = (e: React.MouseEvent, entries: NavHistoryEntry[]) => {
    e.preventDefault();
    if (entries.length === 0) return;
    setHistoryMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const menuItems: ContextMenuItem[] =
    historyMenu?.entries.map((entry) => ({
      label: entry.title,
      onClick: () => nav?.onJump(entry.index),
    })) ?? [];

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-base-100 border-b border-base-300 shrink-0 flex-wrap">
      {sidebarCollapsed && onExpandSidebar && (
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={onExpandSidebar}
          title="Show sidebar"
        >
          <Menu size={16} />
        </button>
      )}
      {nav && (
        <div className="flex gap-1.5">
          <button
            onClick={nav.onBack}
            onContextMenu={(e) => openHistoryMenu(e, nav.backEntries)}
            disabled={!nav.canBack}
            className="btn btn-outline btn-neutral btn-sm"
            title="Back (right-click for history)"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            onClick={nav.onForward}
            onContextMenu={(e) => openHistoryMenu(e, nav.forwardEntries)}
            disabled={!nav.canForward}
            className="btn btn-outline btn-neutral btn-sm"
            title="Forward (right-click for history)"
          >
            <ArrowRight size={16} />
          </button>
        </div>
      )}
      {children}
      {historyMenu && (
        <ContextMenu
          x={historyMenu.x}
          y={historyMenu.y}
          items={menuItems}
          onClose={() => setHistoryMenu(null)}
        />
      )}
    </div>
  );
}
