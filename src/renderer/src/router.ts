import { useState, useEffect, useCallback } from 'react';

// Main pane routing
export type MainPaneView =
  | { type: 'worktree' }
  | { type: 'taskQueue' }
  | { type: 'automations' }
  | { type: 'automationRun'; automationId: string; manualWorkItems?: string[] };

function viewToHash(view: MainPaneView): string {
  switch (view.type) {
    case 'worktree':
      return '#/worktree';
    case 'taskQueue':
      return '#/tasks';
    case 'automations':
      return '#/automations';
    case 'automationRun':
      return `#/automation-run/${view.automationId}`;
  }
}

function hashToView(hash: string): MainPaneView {
  const path = hash.replace(/^#\/?/, '');

  if (path === 'tasks') return { type: 'taskQueue' };
  if (path === 'automations') return { type: 'automations' };

  const runMatch = path.match(/^automation-run\/(.+)$/);
  if (runMatch) return { type: 'automationRun', automationId: runMatch[1] };

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
