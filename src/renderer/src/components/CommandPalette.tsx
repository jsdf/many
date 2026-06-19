import React, { useEffect, useRef, useState } from "react";

// A single selectable row in the palette.
export interface PaletteItem {
  id: string;
  label: string;
  // Secondary text shown right-aligned (e.g. a file's path).
  detail?: string;
  onSelect: () => void;
}

// Generic VSCode-style overlay palette: a centered input over a filtered list,
// driven entirely by the keyboard (up/down to move, enter to pick, escape to
// close) plus mouse hover/click. It owns no domain logic - the parent supplies
// the candidate items for the current query and decides what selecting does.
const CommandPalette: React.FC<{
  placeholder: string;
  query: string;
  onQueryChange: (q: string) => void;
  items: PaletteItem[];
  loading?: boolean;
  emptyText?: string;
  onClose: () => void;
}> = ({ placeholder, query, onQueryChange, items, loading, emptyText, onClose }) => {
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Snap the highlight back to the top whenever the candidate set changes.
  useEffect(() => {
    setHighlight(0);
  }, [items]);

  // Keep the highlighted row visible as it moves.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (items.length === 0 ? 0 : (h + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (items.length === 0 ? 0 : (h - 1 + items.length) % items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[highlight]?.onSelect();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex justify-center items-start pt-[12vh]" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative w-[min(600px,90vw)] bg-base-100 border border-base-300 rounded-lg shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-2 border-b border-base-300">
          <input
            ref={inputRef}
            className="input input-sm w-full"
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-2 text-sm text-base-content/50 flex items-center gap-2">
              <span className="loading loading-spinner loading-xs" /> Searching...
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-base-content/50">{emptyText ?? "No results"}</div>
          ) : (
            items.map((item, i) => (
              <div
                key={item.id}
                data-index={i}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${i === highlight ? "bg-primary/15 text-primary" : "hover:bg-base-200"}`}
                onMouseMove={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  item.onSelect();
                }}
              >
                <span className="truncate">{item.label}</span>
                {item.detail && (
                  <span className="ml-auto pl-2 truncate text-xs text-base-content/50">{item.detail}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
