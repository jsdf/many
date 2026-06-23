import { useSyncExternalStore } from "react";

// The focused terminal/session pane is a single global DOM-focus concept that is
// consumed in two distant places: the pane header (which inverts its colors when
// focused) and the cross-project sessions list (which highlights the focused
// entry). A tiny external store shares that one value without threading focus
// props through the component tree.
let focusedTerminalId: string | null = null;
const listeners = new Set<() => void>();

export function setFocusedTerminal(id: string | null): void {
  if (focusedTerminalId === id) return;
  focusedTerminalId = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return focusedTerminalId;
}

export function useFocusedTerminal(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
