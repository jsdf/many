import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Folder, Terminal, X, Circle } from "lucide-react";
import { ProjectNode, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import TopBar from "./TopBar";
import TerminalStack, { TerminalStackHandle } from "./TerminalStack";
import FileEditorTab, { FileData } from "./FileEditorTab";
import ProjectSessionsTab from "./ProjectSessionsTab";
import FileConflictModal from "./FileConflictModal";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import { relativeToRoot } from "../paths";

const SESSIONS_TAB = "__sessions__";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((err) => console.error("Failed to copy:", err));
}

interface ProjectsPanelProps {
  project: ProjectNode | null;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}

export interface ProjectsPanelHandle {
  openFile: (file: OpenFile) => void;
  newTerminal: () => void;
}

const MIN_PANE_WIDTH = 200;
const DEFAULT_SPLIT = 0.6;

const ProjectsPanel = forwardRef<ProjectsPanelHandle, ProjectsPanelProps>(({
  project,
  sidebarCollapsed,
  onExpandSidebar,
}, ref) => {
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFile, setActiveFile] = useState<string>(SESSIONS_TAB);
  // App-level default Claude Code command, used to launch Claude from this page.
  const [claudeCommand, setClaudeCommand] = useState<string | undefined>(undefined);
  const [fileData, setFileData] = useState<Record<string, FileData>>({});
  // An unresolved on-disk conflict: the file changed externally while it had
  // unsaved edits. diskContent holds the new on-disk version.
  const [conflict, setConflict] = useState<{ path: string; diskContent: string } | null>(null);
  // Right-click context menu for an open file's tab handle.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; file: OpenFile } | null>(null);
  // Live file-content subscriptions, one per open file.
  const fileSubsRef = useRef<Map<string, () => void>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalStackRef = useRef<TerminalStackHandle>(null);
  const prevPathRef = useRef<string | null>(null);
  // Latest fileData, readable from timers/cleanup without stale closures.
  const fileDataRef = useRef(fileData);
  fileDataRef.current = fileData;
  // Pending autosave timers, keyed by file path.
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const AUTOSAVE_DELAY = 600;

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

  // Flush all pending saves (e.g. before switching nodes or unmounting).
  const flushSaves = useCallback(() => {
    for (const filePath of Object.keys(saveTimers.current)) writeNow(filePath);
  }, [writeNow]);

  // When switching nodes, keep only the tabs that belong to the newly selected
  // node. A tab belongs to a node when the file lives directly in that node's
  // directory: files are always opened with the node set to their parent dir
  // (see ProjectsTab.handleOpenFile), so a subproject's files belong to the
  // subproject node, not to an ancestor that merely contains them on disk.
  // (A prefix check would leak a subproject's files up into the project root.)
  useEffect(() => {
    const prev = prevPathRef.current;
    const current = project?.path ?? null;
    prevPathRef.current = current;
    if (prev === null || prev === current) return;
    flushSaves();
    if (current === null) {
      setOpenFiles([]);
      setActiveFile(SESSIONS_TAB);
      setFileData({});
      return;
    }
    const parentDir = (p: string) => {
      const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
      return i >= 0 ? p.slice(0, i) : "";
    };
    const belongsToCurrent = (p: string) => parentDir(p) === current;
    setOpenFiles((prev) => prev.filter((f) => belongsToCurrent(f.path)));
    setFileData((prev) => {
      const next: Record<string, FileData> = {};
      for (const k of Object.keys(prev)) if (belongsToCurrent(k)) next[k] = prev[k];
      return next;
    });
    setActiveFile((cur) => (cur !== SESSIONS_TAB && !belongsToCurrent(cur) ? SESSIONS_TAB : cur));
  }, [project?.path, flushSaves]);

  // Flush any pending saves when the panel unmounts.
  useEffect(() => () => flushSaves(), [flushSaves]);

  // Load the app-level default Claude Code command for launching Claude here.
  useEffect(() => {
    getRpcClient()
      .query("settings.get", {})
      .then((settings) => setClaudeCommand(settings.defaultClaudeCommand || undefined))
      .catch((err) => console.error("Failed to load settings:", err));
  }, []);

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

  useImperativeHandle(ref, () => ({
    openFile: (file: OpenFile) => {
      setOpenFiles((prev) => (prev.some((f) => f.path === file.path) ? prev : [...prev, file]));
      setActiveFile(file.path);
      setFileData((prev) => {
        if (prev[file.path]) return prev;
        loadFile(file.path);
        return prev;
      });
    },
    newTerminal: () => terminalStackRef.current?.createTerminalWithCommand({}, ""),
  }), [loadFile]);

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
        return next.length > 0 ? next[next.length - 1].path : SESSIONS_TAB;
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const total = isNarrow ? rect.height : rect.width;
      const rel = isNarrow ? (e.clientY - rect.top) : (e.clientX - rect.left);
      const fraction = rel / total;
      const minFraction = MIN_PANE_WIDTH / total;
      setSplitFraction(Math.max(minFraction, Math.min(1 - minFraction, fraction)));
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, isNarrow]);

  if (!project) {
    return (
      <div className="flex flex-col h-screen w-full min-w-0 flex-1">
        <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
          <span />
        </TopBar>
        <div className="flex-1 flex items-center justify-center text-base-content/50 text-sm">
          Select a project to view its files and terminals.
        </div>
      </div>
    );
  }

  const active = openFiles.find((f) => f.path === activeFile) ?? null;

  const tabMenuItems = (file: OpenFile): ContextMenuItem[] => [
    { label: "Copy relative path", onClick: () => copyToClipboard(relativeToRoot(file.path, project.path)) },
    { label: "Copy absolute path", onClick: () => copyToClipboard(file.path) },
  ];

  return (
    <div className="flex flex-col p-0 h-screen w-full min-w-0 items-stretch justify-start flex-1">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        <div className="mr-2">
          <h2 className="m-0 text-base font-semibold leading-tight">{project.name}</h2>
          <span className="block text-xs text-base-content/50 leading-tight" title={project.path}>{project.path}</span>
        </div>
        <button
          className="btn btn-outline btn-neutral btn-sm"
          onClick={() => {
            getRpcClient().query("action.openDirectory", { path: project.path })
              .catch((err) => console.error("[action] openDirectory failed:", err));
          }}
        >
          <Folder size={14} /> Folder
        </button>
        <button
          className="btn btn-outline btn-neutral btn-sm"
          onClick={() => {
            getRpcClient().query("action.openTerminalInDir", { path: project.path })
              .catch((err) => console.error("[action] openTerminalInDir failed:", err));
          }}
        >
          <Terminal size={14} /> Terminal
        </button>
      </TopBar>

      <div
        className={`flex-1 flex overflow-hidden min-h-0 ${isNarrow ? 'flex-col' : ''}`}
        ref={containerRef}
        style={{ userSelect: dragging ? "none" : undefined }}
      >
        <div
          className={`flex flex-col overflow-hidden ${isNarrow ? "min-h-[120px]" : "min-w-[200px]"}`}
          style={{ flex: `0 0 ${splitFraction * 100}%` }}
        >
          <div className="flex items-stretch overflow-x-auto bg-base-200 border-b border-base-300 shrink-0">
            <div
              className={`flex items-center gap-1 px-3 py-1.5 text-xs border-r border-base-300 cursor-pointer whitespace-nowrap ${activeFile === SESSIONS_TAB ? "bg-base-100 text-base-content" : "text-base-content/60 hover:text-base-content"}`}
              onClick={() => setActiveFile(SESSIONS_TAB)}
            >
              <span>Sessions</span>
            </div>
            {openFiles.map((f) => {
              const dirty = isDirty(f.path);
              return (
                <div
                  key={f.path}
                  className={`group flex items-center gap-1 px-3 py-1.5 text-xs border-r border-base-300 cursor-pointer whitespace-nowrap ${f.path === activeFile ? "bg-base-100 text-base-content" : "text-base-content/60 hover:text-base-content"}`}
                  onClick={() => setActiveFile(f.path)}
                  onContextMenu={(e) => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, file: f }); }}
                  title={f.path}
                >
                  <span className="truncate max-w-[160px]">{f.name}</span>
                  <button
                    className={`w-3 flex items-center justify-center ${dirty ? "text-base-content/70 group-hover:hidden" : "hidden"}`}
                    title="Unsaved changes"
                    onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
                  >
                    <Circle size={8} className="fill-current" />
                  </button>
                  <button
                    className={`w-3 text-center text-base-content/40 hover:text-error ${dirty ? "hidden group-hover:inline" : ""}`}
                    title="Close"
                    onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex-1 overflow-hidden min-h-0">
            {activeFile === SESSIONS_TAB ? (
              <ProjectSessionsTab
                key={`sessions-${project.path}`}
                worktreePath={project.path}
                onResumeSession={(sessionId, sessionType) => {
                  if (sessionType === "chat") {
                    terminalStackRef.current?.openClaudeSession(sessionId);
                  } else {
                    terminalStackRef.current?.createTerminalWithCommand({}, `${claudeCommand || "claude"} --resume ${sessionId}`);
                  }
                }}
              />
            ) : active && fileData[active.path] ? (
              <FileEditorTab
                key={`${active.path}:${fileData[active.path].version}`}
                fileName={active.name}
                data={fileData[active.path]}
                onChange={(content) => updateContent(active.path, content)}
                onSave={() => saveFile(active.path)}
              />
            ) : null}
          </div>
        </div>

        <div
          className={`shrink-0 transition-colors ${dragging ? 'bg-primary' : 'bg-base-300 hover:bg-primary'} ${isNarrow ? 'h-1 cursor-ns-resize' : 'w-1 cursor-ew-resize'}`}
          onMouseDown={handleMouseDown}
        />

        <div className={`flex-1 flex flex-col overflow-hidden ${isNarrow ? 'min-h-[120px]' : 'min-w-[200px]'}`}>
          <TerminalStack
            ref={terminalStackRef}
            key={`project-terminals-${project.path}`}
            worktreePath={project.path}
            claudeCommand={claudeCommand}
          />
        </div>
      </div>

      {conflict && (
        <FileConflictModal
          fileName={openFiles.find((f) => f.path === conflict.path)?.name ?? conflict.path}
          onKeepMine={resolveKeepMine}
          onReloadDisk={resolveReloadDisk}
          onClose={() => setConflict(null)}
        />
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenu.file)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  );
});

export default ProjectsPanel;
