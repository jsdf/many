import { useState, useEffect, useCallback } from 'react';

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
