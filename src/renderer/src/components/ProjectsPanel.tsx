import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { ProjectNode, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import TopBar from "./TopBar";
import TerminalStack from "./TerminalStack";
import FileEditorTab, { FileData } from "./FileEditorTab";

interface ProjectsPanelProps {
  project: ProjectNode | null;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}

export interface ProjectsPanelHandle {
  openFile: (file: OpenFile) => void;
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
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<Record<string, FileData>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const prevPathRef = useRef<string | null>(null);

  // Reset open tabs when switching between nodes. Skip the first selection
  // (null -> a path) so a file opened in the same click isn't wiped.
  useEffect(() => {
    const prev = prevPathRef.current;
    const current = project?.path ?? null;
    prevPathRef.current = current;
    if (prev !== null && prev !== current) {
      setOpenFiles([]);
      setActiveFile(null);
      setFileData({});
    }
  }, [project?.path]);

  const loadFile = useCallback((filePath: string) => {
    setFileData((prev) => ({
      ...prev,
      [filePath]: { content: "", saved: "", tooLarge: false, binary: false, loaded: false },
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
          },
        }));
      })
      .catch((err) => {
        setFileData((prev) => ({
          ...prev,
          [filePath]: { content: "", saved: "", tooLarge: false, binary: false, loaded: true, error: err instanceof Error ? err.message : String(err) },
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
  }), [loadFile]);

  const updateContent = useCallback((filePath: string, content: string) => {
    setFileData((prev) => {
      const cur = prev[filePath];
      if (!cur || cur.content === content) return prev;
      return { ...prev, [filePath]: { ...cur, content } };
    });
  }, []);

  const saveFile = useCallback((filePath: string) => {
    setFileData((prev) => {
      const cur = prev[filePath];
      if (!cur || cur.content === cur.saved) return prev;
      const toSave = cur.content;
      getRpcClient()
        .query("fs.writeFile", { filePath, content: toSave })
        .then(() => {
          setFileData((p) => {
            const c = p[filePath];
            if (!c) return p;
            return { ...p, [filePath]: { ...c, saved: toSave } };
          });
        })
        .catch((err) => console.error("[fs.writeFile] failed:", err));
      return prev;
    });
  }, []);

  const isDirty = useCallback(
    (filePath: string) => {
      const d = fileData[filePath];
      return !!d && d.loaded && d.content !== d.saved;
    },
    [fileData]
  );

  const closeFile = useCallback((filePath: string) => {
    if (isDirty(filePath) && !window.confirm("This file has unsaved changes. Close without saving?")) {
      return;
    }
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== filePath);
      setActiveFile((current) => {
        if (current !== filePath) return current;
        return next.length > 0 ? next[next.length - 1].path : null;
      });
      return next;
    });
    setFileData((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
  }, [isDirty]);

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

  return (
    <div className="flex flex-col p-0 h-screen w-full min-w-0 items-stretch justify-start flex-1">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        <div className="mr-2">
          <h2 className="m-0 text-base font-semibold leading-tight">{project.name}</h2>
          <span className="block text-xs text-base-content/50 leading-tight" title={project.path}>{project.path}</span>
        </div>
        <button
          className="btn btn-soft btn-neutral btn-sm"
          onClick={() => {
            getRpcClient().query("action.openDirectory", { path: project.path })
              .catch((err) => console.error("[action] openDirectory failed:", err));
          }}
        >
          📁 Folder
        </button>
        <button
          className="btn btn-soft btn-neutral btn-sm"
          onClick={() => {
            getRpcClient().query("action.openTerminalInDir", { path: project.path })
              .catch((err) => console.error("[action] openTerminalInDir failed:", err));
          }}
        >
          💻 Terminal
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
          {openFiles.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-base-content/40 text-sm">
              Open a file from the tree to view it here.
            </div>
          ) : (
            <>
              <div className="flex items-stretch overflow-x-auto bg-base-200 border-b border-base-300 shrink-0">
                {openFiles.map((f) => {
                  const dirty = isDirty(f.path);
                  return (
                    <div
                      key={f.path}
                      className={`group flex items-center gap-1 px-3 py-1.5 text-xs border-r border-base-300 cursor-pointer whitespace-nowrap ${f.path === activeFile ? "bg-base-100 text-base-content" : "text-base-content/60 hover:text-base-content"}`}
                      onClick={() => setActiveFile(f.path)}
                      title={f.path}
                    >
                      <span className="truncate max-w-[160px]">{f.name}</span>
                      <button
                        className={`w-3 text-center ${dirty ? "text-base-content/70 group-hover:hidden" : "hidden"}`}
                        title="Unsaved changes"
                        onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
                      >
                        •
                      </button>
                      <button
                        className={`w-3 text-center text-base-content/40 hover:text-error ${dirty ? "hidden group-hover:inline" : ""}`}
                        title="Close"
                        onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="flex-1 overflow-hidden min-h-0">
                {active && fileData[active.path] && (
                  <FileEditorTab
                    key={active.path}
                    fileName={active.name}
                    data={fileData[active.path]}
                    onChange={(content) => updateContent(active.path, content)}
                    onSave={() => saveFile(active.path)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        <div
          className={`shrink-0 transition-colors ${dragging ? 'bg-primary' : 'bg-base-300 hover:bg-primary'} ${isNarrow ? 'h-1 cursor-ns-resize' : 'w-1 cursor-ew-resize'}`}
          onMouseDown={handleMouseDown}
        />

        <div className={`flex-1 flex flex-col overflow-hidden ${isNarrow ? 'min-h-[120px]' : 'min-w-[200px]'}`}>
          <TerminalStack
            key={`project-terminals-${project.path}`}
            worktreePath={project.path}
          />
        </div>
      </div>
    </div>
  );
});

export default ProjectsPanel;
