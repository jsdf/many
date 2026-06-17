import { useCallback, useEffect, useRef, useState } from "react";
import { FsEntry } from "./types";
import { getRpcClient } from "./rpc-client";

// Tree state is cached at module scope so it survives the consuming component
// unmounting (tab switches, sidebar collapse) for the life of the page.
const treeStateCache: {
  expanded: Set<string>;
  childrenByDir: Map<string, FsEntry[]>;
} = {
  expanded: new Set(),
  childrenByDir: new Map(),
};

export interface FsTree {
  expanded: Set<string>;
  childrenByDir: Map<string, FsEntry[]>;
  loading: Set<string>;
  toggleDir: (dirPath: string) => void;
  expandDir: (dirPath: string) => void;
  expandPath: (dirPath: string, projectPath: string) => void;
  handleToggleDir: (dirPath: string, projectPath: string) => void;
}

// Owns the on-disk directory tree: which directories are expanded, their cached
// children, and the live `fs.dirUpdates` subscriptions that keep those children
// fresh. The set of expanded directories is the source of truth; an effect
// reconciles active subscriptions against it, so toggling only updates state.
export function useFsTree(): FsTree {
  const [expanded, setExpandedState] = useState<Set<string>>(() => treeStateCache.expanded);
  const [childrenByDir, setChildrenByDirState] = useState<Map<string, FsEntry[]>>(
    () => treeStateCache.childrenByDir,
  );
  const [loading, setLoading] = useState<Set<string>>(new Set());

  // Mirror persisted state back into the module cache on every update.
  const setExpanded = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setExpandedState((prev) => (treeStateCache.expanded = updater(prev)));
  }, []);
  const setChildrenByDir = useCallback(
    (updater: (prev: Map<string, FsEntry[]>) => Map<string, FsEntry[]>) => {
      setChildrenByDirState((prev) => (treeStateCache.childrenByDir = updater(prev)));
    },
    [],
  );

  // Live directory subscriptions, one per expanded directory.
  const subsRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const client = getRpcClient();
    const subs = subsRef.current;

    // Subscribe to newly-expanded directories.
    for (const dirPath of expanded) {
      if (subs.has(dirPath)) continue;
      setLoading((prev) => new Set(prev).add(dirPath));
      const unsubscribe = client.subscribe(
        "fs.dirUpdates",
        (entries) => {
          setChildrenByDir((prev) => new Map(prev).set(dirPath, entries));
          setLoading((prev) => {
            if (!prev.has(dirPath)) return prev;
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        },
        { dirPath },
      );
      subs.set(dirPath, unsubscribe);
    }

    // Tear down subscriptions for collapsed directories.
    for (const [dirPath, unsubscribe] of subs) {
      if (expanded.has(dirPath)) continue;
      unsubscribe();
      subs.delete(dirPath);
    }
  }, [expanded, setChildrenByDir]);

  // Tear down all subscriptions on unmount.
  useEffect(() => {
    const subs = subsRef.current;
    return () => {
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    };
  }, []);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) next.delete(dirPath);
        else next.add(dirPath);
        return next;
      });
    },
    [setExpanded],
  );

  // Ensure a directory is expanded without toggling it closed. Used when
  // selecting a directory, so selection also reveals its contents.
  const expandDir = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => (prev.has(dirPath) ? prev : new Set(prev).add(dirPath)));
    },
    [setExpanded],
  );

  // Expand a directory and all its ancestors up to the project root. While
  // filtering, the tree shows matches regardless of `expanded`, so expanding a
  // single dir would leave its ancestors collapsed and the dir unreachable once
  // the filter clears. Recording the whole chain keeps it open afterward.
  const expandPath = useCallback(
    (dirPath: string, projectPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        const sep = dirPath.includes("\\") ? "\\" : "/";
        let cur = dirPath;
        while (cur.length >= projectPath.length) {
          next.add(cur);
          if (cur === projectPath) break;
          const i = cur.lastIndexOf(sep);
          if (i < 0) break;
          cur = cur.slice(0, i);
        }
        return next;
      });
    },
    [setExpanded],
  );

  // Toggle a directory's expansion. Expanding records the full ancestor chain
  // so it survives a filter clear; collapsing just drops the dir itself.
  const handleToggleDir = useCallback(
    (dirPath: string, projectPath: string) => {
      if (expanded.has(dirPath)) toggleDir(dirPath);
      else expandPath(dirPath, projectPath);
    },
    [expanded, toggleDir, expandPath],
  );

  return {
    expanded,
    childrenByDir,
    loading,
    toggleDir,
    expandDir,
    expandPath,
    handleToggleDir,
  };
}
