import { useState, useEffect, useCallback, useRef, useReducer } from 'react';
import type { ProjectNode } from './types';

// Main pane routing
export type MainPaneView =
  | { type: 'worktree' }
  | { type: 'tracked' }
  | { type: 'runningTasks' }
  | { type: 'automations' }
  | { type: 'projects' };

function viewToHash(view: MainPaneView): string {
  switch (view.type) {
    case 'worktree':
      return '#/worktree';
    case 'tracked':
      return '#/tracked';
    case 'runningTasks':
      return '#/running';
    case 'automations':
      return '#/automations';
    case 'projects':
      return '#/projects';
  }
}

function hashToView(hash: string): MainPaneView {
  const path = hash.replace(/^#\/?/, '');

  if (path === 'tracked') return { type: 'tracked' };
  if (path === 'running') return { type: 'runningTasks' };
  if (path === 'automations') return { type: 'automations' };
  if (path === 'projects') return { type: 'projects' };

  return { type: 'worktree' };
}

export function useHashRouter() {
  const [view, setViewState] = useState<MainPaneView>(() =>
    hashToView(window.location.hash)
  );

  // Navigate to a new view, updating the hash
  const navigate = useCallback((newView: MainPaneView) => {
    const newHash = viewToHash(newView);
    if (window.location.hash !== newHash) {
      window.location.hash = newHash;
    }
    setViewState(newView);
  }, []);

  // Listen for back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      setViewState(hashToView(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return { view, navigate };
}

// A point in navigation history: which tab, plus what was selected there. The
// worktree is held by path (resolved to the live object on restore); the
// project node is held whole since it is just a name+path.
export interface NavState {
  view: MainPaneView['type'];
  worktreePath: string | null;
  node: ProjectNode | null;
}

function sameNavState(a: NavState, b: NavState): boolean {
  return (
    a.view === b.view &&
    a.worktreePath === b.worktreePath &&
    (a.node?.path ?? null) === (b.node?.path ?? null)
  );
}

export interface NavHistory {
  record: (state: NavState) => void;
  back: () => NavState | null;
  forward: () => NavState | null;
  canBack: boolean;
  canForward: boolean;
}

// In-memory back/forward history of navigation states. The app calls `record`
// whenever the view or selection changes; `back`/`forward` move the cursor and
// return the state to restore (the caller applies it). Restoring re-fires
// `record`, so a flag suppresses the echo so it isn't pushed as a new entry.
export function useNavHistory(): NavHistory {
  const stackRef = useRef<NavState[]>([]);
  const indexRef = useRef(-1);
  const restoringRef = useRef(false);
  const [, force] = useReducer((c: number) => c + 1, 0);

  const record = useCallback((state: NavState) => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    const top = stackRef.current[indexRef.current];
    if (top && sameNavState(top, state)) return;
    stackRef.current = stackRef.current.slice(0, indexRef.current + 1);
    stackRef.current.push(state);
    indexRef.current = stackRef.current.length - 1;
    force();
  }, []);

  const back = useCallback(() => {
    if (indexRef.current <= 0) return null;
    indexRef.current -= 1;
    restoringRef.current = true;
    force();
    return stackRef.current[indexRef.current];
  }, []);

  const forward = useCallback(() => {
    if (indexRef.current >= stackRef.current.length - 1) return null;
    indexRef.current += 1;
    restoringRef.current = true;
    force();
    return stackRef.current[indexRef.current];
  }, []);

  return {
    record,
    back,
    forward,
    canBack: indexRef.current > 0,
    canForward: indexRef.current < stackRef.current.length - 1,
  };
}
