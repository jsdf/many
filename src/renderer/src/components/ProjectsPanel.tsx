import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { Folder, Terminal, X, Circle, ArrowUp } from "lucide-react";
import { ProjectEntry, ProjectNode, OpenFile } from "../types";
import { getRpcClient } from "../rpc-client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProjectMetadata } from "../hooks/useProjectMetadata";
import { useFileEditors, useOpenFile } from "../useFileEditors";
import TopBar from "./TopBar";
import TerminalStack, { TerminalStackHandle } from "./TerminalStack";
import FileEditorTab from "./FileEditorTab";
import ProjectSessionsTab from "./ProjectSessionsTab";
import ProjectOverviewTab from "./ProjectOverviewTab";
import ProjectLinkButtons from "./ProjectLinkButtons";
import ContextMenu, { ContextMenuItem } from "./ContextMenu";
import { relativeToRoot } from "../paths";

const OVERVIEW_TAB = "__overview__";
const SESSIONS_TAB = "__sessions__";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch((err) => console.error("Failed to copy:", err));
}

export interface ProjectsPanelHandle {
  newTerminal: () => void;
}

interface ProjectsPanelProps {
  project: ProjectNode | null;
  projects: ProjectEntry[];
  onSelectNode: (node: ProjectNode) => void;
  pendingResume: { projectPath: string; sessionId: string; sessionType?: "chat" | "claude-code" } | null;
  onPendingResumeConsumed: () => void;
  pendingOpenFile: { projectPath: string; file: OpenFile } | null;
  onPendingOpenFileConsumed: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onGoToWorktree?: (worktreePath: string) => void;
}

const MIN_PANE_WIDTH = 200;
const DEFAULT_SPLIT = 0.6;

const ProjectsPanel = forwardRef<ProjectsPanelHandle, ProjectsPanelProps>(({
  project,
  pendingResume,
  onPendingResumeConsumed,
  pendingOpenFile,
  onPendingOpenFileConsumed,
  sidebarCollapsed,
  onExpandSidebar,
  onGoToWorktree,
  projects,
  onSelectNode,
}, ref) => {
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const [splitFraction, setSplitFraction] = useState(DEFAULT_SPLIT);
  const [dragging, setDragging] = useState(false);
  // App-level default Claude Code command, used to launch Claude from this page.
  const [claudeCommand, setClaudeCommand] = useState<string | undefined>(undefined);
  const [claudeCommandLoaded, setClaudeCommandLoaded] = useState(false);
  // Right-click context menu for an open file's tab handle.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; file: OpenFile } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalStackRef = useRef<TerminalStackHandle>(null);

  const {
    openFiles,
    activeFile,
    setActiveFile,
    fileData,
    closeFile,
    updateContent,
    saveFile,
    isDirty,
  } = useFileEditors(project?.path ?? null, OVERVIEW_TAB);

  const openFileInContext = useOpenFile();

  // Project sidecar metadata (PROJECT.md frontmatter, prs.yml, tasks.yml),
  // owned by the hook so both the header link buttons and the Overview tab
  // share it, and so it stays consistent with the selected project.
  const { meta, loading: metaLoading, reload: loadMeta, refreshPrs, refreshingPrs } = useProjectMetadata(project);

  // Auto-open PROJECT.md once per project when it exists, so selecting a project
  // surfaces its overview document. Deduped per project path so the user can
  // close the tab without it re-opening while the project stays selected. `meta`
  // is always consistent with the current project, so this can't read a
  // PROJECT.md the newly selected project doesn't have.
  const autoOpenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!project || !meta?.hasProjectMd) return;
    if (autoOpenedRef.current.has(project.path)) return;
    autoOpenedRef.current.add(project.path);
    const sep = project.path.includes("\\") ? "\\" : "/";
    const filePath = `${project.path}${sep}PROJECT.md`;
    openFileInContext(project.path, { path: filePath, name: "PROJECT.md" });
    setActiveFile(filePath);
  }, [project?.path, meta?.hasProjectMd, openFileInContext, setActiveFile]);

  // Load the app-level default Claude Code command for launching Claude here.
  useEffect(() => {
    getRpcClient()
      .query("settings.get", {})
      .then((settings) => setClaudeCommand(settings.defaultClaudeCommand || undefined))
      .catch((err) => console.error("Failed to load settings:", err))
      .finally(() => setClaudeCommandLoaded(true));
  }, []);

  // Resume a queued Claude session once this panel is mounted for its project
  // (and settings are loaded so we use the configured command). The terminal
  // stack is keyed per project, so the ref points at the right project's stack.
  useEffect(() => {
    if (!claudeCommandLoaded || !pendingResume || !project) return;
    if (pendingResume.projectPath !== project.path) return;
    const { sessionId, sessionType } = pendingResume;
    if (sessionType === "chat") {
      terminalStackRef.current?.openClaudeSession(sessionId);
    } else {
      terminalStackRef.current?.resumeClaudeCodeSession(sessionId, `${claudeCommand || "claude"} --resume ${sessionId}`);
    }
    onPendingResumeConsumed();
  }, [pendingResume, project?.path, claudeCommand, claudeCommandLoaded, onPendingResumeConsumed]);

  // Open a file queued from elsewhere (e.g. the palette) once this panel is
  // mounted for its project, so it lands in the right project's editor (which is
  // keyed per root path). Mirrors the pendingResume flow above.
  useEffect(() => {
    if (!pendingOpenFile || !project) return;
    if (pendingOpenFile.projectPath !== project.path) return;
    openFileInContext(project.path, pendingOpenFile.file);
    setActiveFile(pendingOpenFile.file.path);
    onPendingOpenFileConsumed();
  }, [pendingOpenFile, project?.path, openFileInContext, setActiveFile, onPendingOpenFileConsumed]);

  useImperativeHandle(ref, () => ({
    newTerminal: () => terminalStackRef.current?.createTerminalWithCommand({}, ""),
  }), []);

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

  // Parent node for the "up" button: the current node's parent directory,
  // unless the current node is itself a registered project root (nothing above
  // it in the projects tree). Reuses the registered project name when the
  // parent is a root.
  const sep = project.path.includes("\\") ? "\\" : "/";
  const isProjectRoot = projects.some((p) => p.path === project.path);
  const parentPath = project.path.slice(0, project.path.lastIndexOf(sep));
  const parentNode: ProjectNode | null =
    !isProjectRoot && parentPath
      ? {
          path: parentPath,
          name: projects.find((p) => p.path === parentPath)?.name ?? parentPath.slice(parentPath.lastIndexOf(sep) + 1),
        }
      : null;

  const tabMenuItems = (file: OpenFile): ContextMenuItem[] => [
    { label: "Open in default app", onClick: () => getRpcClient().query("action.openPath", { path: file.path }).catch((err) => console.error("[action] openPath failed:", err)) },
    { label: "Copy relative path", onClick: () => copyToClipboard(relativeToRoot(file.path, project.path)) },
    { label: "Copy absolute path", onClick: () => copyToClipboard(file.path) },
  ];

  return (
    <div className="flex flex-col p-0 h-screen w-full min-w-0 items-stretch justify-start flex-1">
      <TopBar sidebarCollapsed={sidebarCollapsed} onExpandSidebar={onExpandSidebar}>
        {parentNode && (
          <button
            className="btn btn-ghost btn-sm btn-square mr-1"
            title={`Up to ${parentNode.name}`}
            onClick={() => onSelectNode(parentNode)}
          >
            <ArrowUp size={16} />
          </button>
        )}
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
        {meta && <ProjectLinkButtons links={meta.links} className="ml-auto" />}
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
              className={`flex items-center gap-1 px-3 py-1.5 text-xs border-r border-base-300 cursor-pointer whitespace-nowrap ${activeFile === OVERVIEW_TAB ? "bg-base-100 text-base-content" : "text-base-content/60 hover:text-base-content"}`}
              onClick={() => setActiveFile(OVERVIEW_TAB)}
            >
              <span>Overview</span>
            </div>
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
            {activeFile === OVERVIEW_TAB ? (
              <ProjectOverviewTab
                key={`overview-${project.path}`}
                meta={meta}
                loading={metaLoading}
                onRefresh={loadMeta}
                onRefreshPrs={refreshPrs}
                refreshingPrs={refreshingPrs}
                onGoToWorktree={onGoToWorktree}
              />
            ) : activeFile === SESSIONS_TAB ? (
              <ProjectSessionsTab
                key={`sessions-${project.path}`}
                worktreePath={project.path}
                onResumeSession={(sessionId, target) => {
                  if (target === "ui") {
                    terminalStackRef.current?.openClaudeSession(sessionId);
                  } else {
                    terminalStackRef.current?.resumeClaudeCodeSession(sessionId, `${claudeCommand || "claude"} --resume ${sessionId}`);
                  }
                }}
              />
            ) : active && fileData[active.path] ? (
              <FileEditorTab
                key={`${active.path}:${fileData[active.path].version}`}
                fileName={active.name}
                filePath={active.path}
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
