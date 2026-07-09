import { createContext, useContext } from "react";
import type { NavHistoryEntry } from "./router";

// Navigation history controls live in App but are surfaced in every pane's
// TopBar. A context avoids threading back/forward props through each pane.
export interface NavContextValue {
  onBack: () => void;
  onForward: () => void;
  onJump: (index: number) => void;
  canBack: boolean;
  canForward: boolean;
  // Entries reachable in each direction, nearest first, for the right-click
  // history menus on the back/forward buttons.
  backEntries: NavHistoryEntry[];
  forwardEntries: NavHistoryEntry[];
}

export const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue | null {
  return useContext(NavContext);
}
