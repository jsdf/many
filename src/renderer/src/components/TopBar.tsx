import React from "react";
import { Menu, ArrowLeft, ArrowRight } from "lucide-react";
import { useNav } from "../nav-context";

interface TopBarProps {
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  children: React.ReactNode;
}

export default function TopBar({ sidebarCollapsed, onExpandSidebar, children }: TopBarProps) {
  const nav = useNav();
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
            disabled={!nav.canBack}
            className="btn btn-outline btn-neutral btn-sm"
            title="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <button
            onClick={nav.onForward}
            disabled={!nav.canForward}
            className="btn btn-outline btn-neutral btn-sm"
            title="Forward"
          >
            <ArrowRight size={16} />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
