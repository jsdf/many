import { useState, useEffect, useCallback, useRef } from "react";
import { OpenFile } from "./types";
import { getRpcClient } from "./rpc-client";
import { FileData } from "./components/FileEditorTab";

const AUTOSAVE_DELAY = 600;

const parentDir = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
};

// A file belongs to a node when it lives directly in that node's directory.
// Files are opened with the node set to their parent dir, so a subproject's
// files belong to the subproject node, not an ancestor that contains them.
export const belongsToDir = (filePath: string, rootPath: string) =>
  parentDir(filePath) === rootPath;

// A file belongs to a worktree when it lives anywhere under the worktree path.
export const belongsUnder = (filePath: string, rootPath: string) => {
  const sep = filePath.includes("\\") ? "\\" : "/";
  return filePath === rootPath || filePath.startsWith(rootPath + sep);
};

export interface FileEditors {
  openFiles: OpenFile[];
  activeFile: string;
  setActiveFile: React.Dispatch<React.SetStateAction<string>>;
  fileData: Record<string, FileData>;
  openFile: (file: OpenFile) => void;
  closeFile: (filePath: string) => void;
  updateContent: (filePath: string, content: string) => void;
  saveFile: (filePath: string) => void;
  isDirty: (filePath: string) => boolean;
  conflict: { path: string; diskContent: string } | null;
  setConflict: React.Dispatch<
    React.SetStateAction<{ path: string; diskContent: string } | null>
  >;
  resolveKeepMine: () => void;
  resolveReloadDisk: () => void;
}

// Owns the set of open file tabs and their editor state for a single root
// directory (a project node or a worktree): content, autosave, on-disk conflict
// detection, and live content subscriptions. Switching roots flushes pending
// saves and keeps only the tabs whose files belong to the new root.
//
// `belongs` decides which open files survive a root change (direct-child for
// project nodes, anywhere-under for worktrees). `defaultTab` is the id of the
// non-file tab the active selection falls back to (e.g. "Sessions", "Details").
export function useFileEditors(opts: {
  rootPath: string | null;
  defaultTab: string;
  belongs: (filePath: string, rootPath: string) => boolean;
}): FileEditors {
  const { rootPath, defaultTab, belongs } = opts;
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string>(defaultTab);
  const [fileData, setFileData] = useState<Record<string, FileData>>({});
  // An unresolved on-disk conflict: the file changed externally while it had
  // unsaved edits. diskContent holds the new on-disk version.
  const [conflict, setConflict] = useState<{ path: string; diskContent: string } | null>(null);
  // Live file-content subscriptions, one per open file.
  const fileSubsRef = useRef<Map<string, () => void>>(new Map());
  const prevPathRef = useRef<string | null>(null);
  // Latest fileData, readable from timers/cleanup without stale closures.
  const fileDataRef = useRef(fileData);
  fileDataRef.current = fileData;
  // Pending autosave timers, keyed by file path.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Stable refs for the caller-supplied predicate / default tab.
  const belongsRef = useRef(belongs);
  belongsRef.current = belongs;
  const defaultTabRef = useRef(defaultTab);
  defaultTabRef.current = defaultTab;

  // Persist a file immediately if it has unsaved changes.
  const writeNow = useCallback((filePath: string) => {
    const timer = saveTimers.current[filePath];
    if (timer) {
      clearTimeout(timer);
      delete saveTimers.current[filePath];
    }
    const cur = fileDataRef.current[filePath];
    if (!cur || !cur.loaded || cur.content === cur.saved) return;
    const toSave = cur.content;
    getRpcClient()
      .query("fs.writeFile", { filePath, content: toSave })
      .then(() => {
        setFileData((p) => (p[filePath] ? { ...p, [filePath]: { ...p[filePath], saved: toSave } } : p));
      })
      .catch((err) => console.error("[fs.writeFile] failed:", err));
  }, []);

  const scheduleSave = useCallback((filePath: string) => {
    if (saveTimers.current[filePath]) clearTimeout(saveTimers.current[filePath]);
    saveTimers.current[filePath] = setTimeout(() => writeNow(filePath), AUTOSAVE_DELAY);
  }, [writeNow]);

  // Flush all pending saves (e.g. before switching roots or unmounting).
  const flushSaves = useCallback(() => {
    for (const filePath of Object.keys(saveTimers.current)) writeNow(filePath);
  }, [writeNow]);

  // When switching roots, keep only the tabs that belong to the newly selected
  // root (per the caller's predicate) and reset the active tab if it no longer
  // belongs.
  useEffect(() => {
    const prev = prevPathRef.current;
    const current = rootPath ?? null;
    prevPathRef.current = current;
    if (prev === null || prev === current) return;
    flushSaves();
    if (current === null) {
      setOpenFiles([]);
      setActiveFile(defaultTabRef.current);
      setFileData({});
      return;
    }
    const belongsToCurrent = (p: string) => belongsRef.current(p, current);
    setOpenFiles((prev) => prev.filter((f) => belongsToCurrent(f.path)));
    setFileData((prev) => {
      const next: Record<string, FileData> = {};
      for (const k of Object.keys(prev)) if (belongsToCurrent(k)) next[k] = prev[k];
      return next;
    });
    setActiveFile((cur) =>
      cur !== defaultTabRef.current && !belongsToCurrent(cur) ? defaultTabRef.current : cur,
    );
  }, [rootPath, flushSaves]);

  // Flush any pending saves when the consumer unmounts.
  useEffect(() => () => flushSaves(), [flushSaves]);

  const loadFile = useCallback((filePath: string) => {
    setFileData((prev) => ({
      ...prev,
      [filePath]: { content: "", saved: "", tooLarge: false, binary: false, loaded: false, version: 0 },
    }));
    getRpcClient()
      .query("fs.readFile", { filePath })
      .then((res) => {
        setFileData((prev) => ({
          ...prev,
          [filePath]: {
            content: res.content,
            saved: res.content,
            tooLarge: res.tooLarge,
            binary: res.binary,
            loaded: true,
            version: (prev[filePath]?.version ?? 0) + 1,
          },
        }));
      })
      .catch((err) => {
        setFileData((prev) => ({
          ...prev,
          [filePath]: { content: "", saved: "", tooLarge: false, binary: false, loaded: true, version: 0, error: err instanceof Error ? err.message : String(err) },
        }));
      });
  }, []);

  const openFile = useCallback((file: OpenFile) => {
    setOpenFiles((prev) => (prev.some((f) => f.path === file.path) ? prev : [...prev, file]));
    setActiveFile(file.path);
    setFileData((prev) => {
      if (prev[file.path]) return prev;
      loadFile(file.path);
      return prev;
    });
  }, [loadFile]);

  const updateContent = useCallback((filePath: string, content: string) => {
    setFileData((prev) => {
      const cur = prev[filePath];
      if (!cur || cur.content === content) return prev;
      return { ...prev, [filePath]: { ...cur, content } };
    });
    scheduleSave(filePath);
  }, [scheduleSave]);

  const saveFile = useCallback((filePath: string) => writeNow(filePath), [writeNow]);

  const isDirty = useCallback(
    (filePath: string) => {
      const d = fileData[filePath];
      return !!d && d.loaded && d.content !== d.saved;
    },
    [fileData]
  );

  const closeFile = useCallback((filePath: string) => {
    // Flush any pending autosave before dropping the file's state.
    writeNow(filePath);
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== filePath);
      setActiveFile((current) => {
        if (current !== filePath) return current;
        return next.length > 0 ? next[next.length - 1].path : defaultTabRef.current;
      });
      return next;
    });
    setFileData((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
  }, [writeNow]);

  // Handle a file's on-disk content changing while it's open in the editor.
  const handleDiskUpdate = useCallback((filePath: string, res: { content: string; tooLarge: boolean; binary: boolean }) => {
    const cur = fileDataRef.current[filePath];
    if (!cur || !cur.loaded || res.tooLarge || res.binary) return;
    const incoming = res.content;
    // Matches our last persisted baseline (incl. our own writes echoing back).
    if (incoming === cur.saved) return;
    const dirty = cur.content !== cur.saved;
    if (!dirty) {
      // No unsaved edits: adopt the on-disk content and remount the editor.
      setFileData((prev) => {
        const c = prev[filePath];
        if (!c) return prev;
        return { ...prev, [filePath]: { ...c, content: incoming, saved: incoming, version: c.version + 1 } };
      });
    } else {
      // Unsaved edits would be lost: cancel pending autosave (so we don't
      // clobber the disk version before the user decides) and prompt.
      if (saveTimers.current[filePath]) {
        clearTimeout(saveTimers.current[filePath]);
        delete saveTimers.current[filePath];
      }
      setConflict((c) => (c && c.path !== filePath ? c : { path: filePath, diskContent: incoming }));
    }
  }, []);

  // Subscribe to live content for each open file; unsubscribe when closed.
  useEffect(() => {
    const client = getRpcClient();
    const subs = fileSubsRef.current;
    const want = new Set(openFiles.map((f) => f.path));
    for (const f of openFiles) {
      if (subs.has(f.path)) continue;
      const unsubscribe = client.subscribe("fs.fileUpdates", (res) => handleDiskUpdate(f.path, res), { filePath: f.path });
      subs.set(f.path, unsubscribe);
    }
    for (const [p, unsubscribe] of subs) {
      if (want.has(p)) continue;
      unsubscribe();
      subs.delete(p);
    }
  }, [openFiles, handleDiskUpdate]);

  useEffect(() => {
    const subs = fileSubsRef.current;
    return () => {
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
    };
  }, []);

  // Conflict resolution: discard the editor's edits and load the disk version.
  const resolveReloadDisk = useCallback(() => {
    setConflict((c) => {
      if (!c) return null;
      const { path: p, diskContent } = c;
      if (saveTimers.current[p]) {
        clearTimeout(saveTimers.current[p]);
        delete saveTimers.current[p];
      }
      setFileData((prev) => {
        const cur = prev[p];
        if (!cur) return prev;
        return { ...prev, [p]: { ...cur, content: diskContent, saved: diskContent, version: cur.version + 1 } };
      });
      return null;
    });
  }, []);

  // Conflict resolution: keep the editor's edits and write them over disk.
  const resolveKeepMine = useCallback(() => {
    setConflict((c) => {
      if (!c) return null;
      const p = c.path;
      const cur = fileDataRef.current[p];
      if (cur) {
        const mine = cur.content;
        getRpcClient()
          .query("fs.writeFile", { filePath: p, content: mine })
          .then(() => setFileData((prev) => (prev[p] ? { ...prev, [p]: { ...prev[p], saved: mine } } : prev)))
          .catch((err) => console.error("[fs.writeFile] failed:", err));
      }
      return null;
    });
  }, []);

  return {
    openFiles,
    activeFile,
    setActiveFile,
    fileData,
    openFile,
    closeFile,
    updateContent,
    saveFile,
    isDirty,
    conflict,
    setConflict,
    resolveKeepMine,
    resolveReloadDisk,
  };
}
