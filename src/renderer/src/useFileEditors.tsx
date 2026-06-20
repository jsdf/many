import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { OpenFile } from "./types";
import { getRpcClient } from "./rpc-client";
import { FileData } from "./components/FileEditorTab";
import FileConflictModal from "./components/FileConflictModal";

const AUTOSAVE_DELAY = 600;

const baseName = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
};

// The set of open file tabs and the active tab for a single root directory
// (a project node or a worktree).
interface RootEditors {
  openFiles: OpenFile[];
  activeFile: string;
}

interface FileEditorsContextValue {
  editorsByRoot: Record<string, RootEditors>;
  fileData: Record<string, FileData>;
  openFile: (rootPath: string, file: OpenFile) => void;
  closeFile: (rootPath: string, filePath: string) => void;
  setActiveFile: (rootPath: string, id: string) => void;
  updateContent: (filePath: string, content: string) => void;
  saveFile: (filePath: string) => void;
  isDirty: (filePath: string) => boolean;
}

const FileEditorsContext = createContext<FileEditorsContextValue | null>(null);

const NO_FILES: OpenFile[] = [];

// Hoists open-file editor state above the panels so it survives panel
// unmount/remount (switching between the Projects and Worktree views) and is
// remembered per root: each worktree/project node keeps its own open tabs and
// active tab. Owns content, autosave, on-disk conflict detection, and the live
// `fs.fileUpdates` subscriptions for every open file across all roots.
export const FileEditorsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Open tabs + active tab, keyed by root path.
  const [editorsByRoot, setEditorsByRoot] = useState<Record<string, RootEditors>>({});
  // File content + save state, keyed by file path (a file has one parent, so it
  // belongs to at most one root; sharing by path keeps it simple).
  const [fileData, setFileData] = useState<Record<string, FileData>>({});
  // An unresolved on-disk conflict: the file changed externally while it had
  // unsaved edits. diskContent holds the new on-disk version.
  const [conflict, setConflict] = useState<{ path: string; diskContent: string } | null>(null);
  // Live file-content subscriptions, one per open file.
  const fileSubsRef = useRef<Map<string, () => void>>(new Map());
  // Latest fileData, readable from timers/cleanup without stale closures.
  const fileDataRef = useRef(fileData);
  fileDataRef.current = fileData;
  // Pending autosave timers, keyed by file path.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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

  // Flush all pending saves when the app tears down.
  useEffect(() => () => {
    for (const filePath of Object.keys(saveTimers.current)) writeNow(filePath);
  }, [writeNow]);

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

  const openFile = useCallback((rootPath: string, file: OpenFile) => {
    setEditorsByRoot((prev) => {
      const cur = prev[rootPath] ?? { openFiles: [], activeFile: "" };
      const openFiles = cur.openFiles.some((f) => f.path === file.path)
        ? cur.openFiles
        : [...cur.openFiles, file];
      return { ...prev, [rootPath]: { openFiles, activeFile: file.path } };
    });
    setFileData((prev) => {
      if (prev[file.path]) return prev;
      loadFile(file.path);
      return prev;
    });
  }, [loadFile]);

  const setActiveFile = useCallback((rootPath: string, id: string) => {
    setEditorsByRoot((prev) => {
      const cur = prev[rootPath] ?? { openFiles: [], activeFile: "" };
      return { ...prev, [rootPath]: { ...cur, activeFile: id } };
    });
  }, []);

  const closeFile = useCallback((rootPath: string, filePath: string) => {
    // Flush any pending autosave before dropping the file's state.
    writeNow(filePath);
    setEditorsByRoot((prev) => {
      const cur = prev[rootPath];
      if (!cur) return prev;
      const openFiles = cur.openFiles.filter((f) => f.path !== filePath);
      const activeFile =
        cur.activeFile === filePath
          ? openFiles.length > 0
            ? openFiles[openFiles.length - 1].path
            : "" // empty falls back to the consumer's default tab
          : cur.activeFile;
      return { ...prev, [rootPath]: { openFiles, activeFile } };
    });
    setFileData((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
  }, [writeNow]);

  const updateContent = useCallback((filePath: string, content: string) => {
    setFileData((prev) => {
      const cur = prev[filePath];
      if (!cur || cur.content === content) return prev;
      return { ...prev, [filePath]: { ...cur, content } };
    });
    scheduleSave(filePath);
  }, [scheduleSave]);

  const saveFile = useCallback((filePath: string) => writeNow(filePath), [writeNow]);

  const isDirty = useCallback((filePath: string) => {
    const d = fileData[filePath];
    return !!d && d.loaded && d.content !== d.saved;
  }, [fileData]);

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

  // Every open file path across all roots; drives the subscription set.
  const openPaths = useMemo(() => {
    const set = new Set<string>();
    for (const root of Object.values(editorsByRoot)) {
      for (const f of root.openFiles) set.add(f.path);
    }
    return [...set];
  }, [editorsByRoot]);

  // Subscribe to live content for each open file; unsubscribe when closed.
  useEffect(() => {
    const client = getRpcClient();
    const subs = fileSubsRef.current;
    const want = new Set(openPaths);
    for (const p of openPaths) {
      if (subs.has(p)) continue;
      const unsubscribe = client.subscribe("fs.fileUpdates", (res) => handleDiskUpdate(p, res), { filePath: p });
      subs.set(p, unsubscribe);
    }
    for (const [p, unsubscribe] of subs) {
      if (want.has(p)) continue;
      unsubscribe();
      subs.delete(p);
    }
  }, [openPaths, handleDiskUpdate]);

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

  const value = useMemo<FileEditorsContextValue>(
    () => ({ editorsByRoot, fileData, openFile, closeFile, setActiveFile, updateContent, saveFile, isDirty }),
    [editorsByRoot, fileData, openFile, closeFile, setActiveFile, updateContent, saveFile, isDirty],
  );

  return (
    <FileEditorsContext.Provider value={value}>
      {children}
      {conflict && (
        <FileConflictModal
          fileName={baseName(conflict.path)}
          onKeepMine={resolveKeepMine}
          onReloadDisk={resolveReloadDisk}
          onClose={() => setConflict(null)}
        />
      )}
    </FileEditorsContext.Provider>
  );
};

function useFileEditorsContext(): FileEditorsContextValue {
  const ctx = useContext(FileEditorsContext);
  if (!ctx) throw new Error("useFileEditors must be used within a FileEditorsProvider");
  return ctx;
}

export interface FileEditors {
  openFiles: OpenFile[];
  activeFile: string;
  setActiveFile: (id: string) => void;
  fileData: Record<string, FileData>;
  closeFile: (filePath: string) => void;
  updateContent: (filePath: string, content: string) => void;
  saveFile: (filePath: string) => void;
  isDirty: (filePath: string) => boolean;
}

// Panel-facing view of the editor state for a single root. `defaultTab` is the
// id of the non-file tab the active selection falls back to when no file is
// open (e.g. "Sessions", "Details").
export function useFileEditors(rootPath: string | null, defaultTab: string): FileEditors {
  const ctx = useFileEditorsContext();
  const root = rootPath ?? "";
  const entry = ctx.editorsByRoot[root];
  return {
    openFiles: entry?.openFiles ?? NO_FILES,
    activeFile: entry?.activeFile || defaultTab,
    setActiveFile: useCallback((id: string) => ctx.setActiveFile(root, id), [ctx, root]),
    fileData: ctx.fileData,
    closeFile: useCallback((filePath: string) => ctx.closeFile(root, filePath), [ctx, root]),
    updateContent: ctx.updateContent,
    saveFile: ctx.saveFile,
    isDirty: ctx.isDirty,
  };
}

// Opens a file in the editor for an explicit root, for the file-tree sidebars.
export function useOpenFile(): (rootPath: string, file: OpenFile) => void {
  return useFileEditorsContext().openFile;
}
