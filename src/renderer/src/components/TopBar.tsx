import React from "react";

interface TopBarProps {
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  children: React.ReactNode;
}

export default function TopBar({ sidebarCollapsed, onExpandSidebar, children }: TopBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-base-100 border-b border-base-300 shrink-0 flex-wrap">
      {sidebarCollapsed && onExpandSidebar && (
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={onExpandSidebar}
          title="Show sidebar"
        >
          &#9776;
        </button>
      )}
      {children}
    </div>
  );
}
