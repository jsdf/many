import { createContext, useContext } from "react";

// Navigation history controls live in App but are surfaced in every pane's
// TopBar. A context avoids threading back/forward props through each pane.
export interface NavContextValue {
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
}

export const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue | null {
  return useContext(NavContext);
}
