import React, { useState } from "react";
import { RotateCw, Star, GitPullRequest, CheckSquare, ChevronRight, Server, ExternalLink, FolderOpen, Cloud } from "lucide-react";
import type { ProjectMetadata, ProjectPr, ProjectTask, ProjectEnv } from "../../../shared/protocol";

interface ProjectOverviewTabProps {
  meta: ProjectMetadata | null;
  loading: boolean;
  onRefresh: () => void;
  // Refetches PR state from GitHub and writes it back to prs.yml. Resolves with
  // the refresh outcome.
  onRefreshPrs: () => Promise<{ refreshed: number; errors: string[] }>;
  refreshingPrs: boolean;
  // Select the worktree at this path in the worktree pane. Undefined disables
  // the "go to worktree" action on worktree-kind env rows.
  onGoToWorktree?: (worktreePath: string) => void;
}

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// daisyUI badge class for a PR status.
function prStatusBadge(status?: string): string {
  switch (status) {
    case "open":
      return "badge-success";
    case "merged":
      return "badge-accent";
    case "closed":
      return "badge-error";
    case "draft":
    default:
      return "badge-neutral";
  }
}

// daisyUI badge class for a task status.
function taskStatusBadge(status?: string): string {
  switch (status) {
    case "done":
      return "badge-success";
    case "in-progress":
      return "badge-info";
    case "blocked":
      return "badge-error";
    case "todo":
    default:
      return "badge-neutral";
  }
}

// A collapsible overview section with a header (icon + title + count) that
// toggles its body. Expanded by default.
const Section: React.FC<{
  icon: React.ReactNode;
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, count, action, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <div className="flex items-center mb-2">
        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-sm font-semibold text-base-content/70 hover:text-base-content"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
          {icon} {title}{count > 0 ? ` (${count})` : ""}
        </button>
        {action}
      </div>
      {open && (count === 0 ? <p className="text-xs text-base-content/40">None.</p> : children)}
    </section>
  );
};

const PrRow: React.FC<{ pr: ProjectPr }> = ({ pr }) => (
  <div
    className={`bg-base-200 border border-base-300 rounded-lg p-3 ${pr.url ? "hover:border-primary/50 cursor-pointer" : ""}`}
    onClick={() => pr.url && openUrl(pr.url)}
  >
    <div className="flex items-center gap-2 mb-1 min-w-0">
      {pr.status && <span className={`badge badge-xs shrink-0 ${prStatusBadge(pr.status)}`}>{pr.status}</span>}
      {pr.branch && (
        <span className="text-xs text-base-content/50 font-mono truncate min-w-0">{pr.branch}</span>
      )}
    </div>
    <p className="text-sm text-base-content/80 m-0 line-clamp-2">
      {pr.title || pr.url || <span className="italic text-base-content/40">Untitled PR</span>}
    </p>
    {pr.notes && <p className="text-xs text-base-content/50 mt-1 line-clamp-2">{pr.notes}</p>}
  </div>
);

const TaskRow: React.FC<{ task: ProjectTask }> = ({ task }) => (
  <div
    className={`bg-base-200 border border-base-300 rounded-lg p-3 ${task.url ? "hover:border-primary/50 cursor-pointer" : ""}`}
    onClick={() => task.url && openUrl(task.url)}
  >
    <div className="flex items-center gap-2 mb-1 min-w-0">
      {task.focused && (
        <span className="shrink-0 text-warning" title="Focused">
          <Star size={12} className="fill-current" />
        </span>
      )}
      {task.status && (
        <span className={`badge badge-xs shrink-0 ${taskStatusBadge(task.status)}`}>{task.status}</span>
      )}
    </div>
    <p className="text-sm text-base-content/80 m-0 line-clamp-2">
      {task.title || task.url || <span className="italic text-base-content/40">Untitled task</span>}
    </p>
    {task.notes && <p className="text-xs text-base-content/50 mt-1 line-clamp-2">{task.notes}</p>}
  </div>
);

const EnvRow: React.FC<{ env: ProjectEnv; onGoToWorktree?: (path: string) => void }> = ({ env, onGoToWorktree }) => {
  const isWorktree = env.kind === "worktree";
  // Worktrees open in the worktree pane; cloud sessions open their session URL.
  const canGoToWorktree = isWorktree && !!env.path && !!onGoToWorktree;
  const canOpenUrl = !isWorktree && !!env.url;
  const activate = () => {
    if (canGoToWorktree) onGoToWorktree!(env.path!);
    else if (canOpenUrl) openUrl(env.url!);
  };
  const clickable = canGoToWorktree || canOpenUrl;
  return (
    <div
      className={`bg-base-200 border border-base-300 rounded-lg p-3 ${clickable ? "hover:border-primary/50 cursor-pointer" : ""}`}
      onClick={clickable ? activate : undefined}
    >
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <span className="badge badge-xs badge-neutral shrink-0 gap-1">
          {isWorktree ? <FolderOpen size={10} /> : <Cloud size={10} />}
          {env.kind || "env"}
        </span>
        {env.branch && (
          <span className="text-xs text-base-content/50 font-mono truncate min-w-0">{env.branch}</span>
        )}
        {clickable && (
          <span className="shrink-0 ml-auto text-base-content/40" title={canGoToWorktree ? "Go to worktree" : "Open session"}>
            <ExternalLink size={12} />
          </span>
        )}
      </div>
      <p className="text-sm text-base-content/80 m-0 font-mono truncate">
        {env.path || env.url || <span className="italic font-sans text-base-content/40">No location</span>}
      </p>
      {env.notes && <p className="text-xs text-base-content/50 mt-1 line-clamp-2">{env.notes}</p>}
    </div>
  );
};

const ProjectOverviewTab: React.FC<ProjectOverviewTabProps> = ({
  meta,
  loading,
  onRefresh,
  onRefreshPrs,
  refreshingPrs,
  onGoToWorktree,
}) => {
  const hasAnyFiles = meta && (meta.hasProjectMd || meta.hasPrs || meta.hasTasks || meta.hasEnvs);
  const [prError, setPrError] = useState<string | null>(null);

  const handleRefreshPrs = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setPrError(null);
    try {
      const { errors } = await onRefreshPrs();
      setPrError(errors.length > 0 ? errors.join("\n") : null);
    } catch (err) {
      setPrError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="h-full flex flex-col bg-base-100">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-base-300 shrink-0">
        <span className="text-xs font-semibold text-base-content/60">Overview</span>
        <button className="btn btn-ghost btn-xs" onClick={onRefresh} title="Refresh">
          <RotateCw size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {loading && !meta ? (
          <div className="flex items-center justify-center h-full">
            <span className="loading loading-spinner loading-md" />
          </div>
        ) : !hasAnyFiles ? (
          <p className="text-base-content/50 text-xs text-center mt-4">
            No project files found. Add a PROJECT.md (with notion/linear frontmatter), prs.yml, tasks.yml, or envs.yml to
            this directory.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {meta!.title && <h3 className="text-base font-semibold m-0">{meta!.title}</h3>}

            {meta!.hasPrs && (
              <Section
                icon={<GitPullRequest size={14} />}
                title="PRs"
                count={meta!.prs.length}
                action={
                  <button
                    className="btn btn-ghost btn-xs"
                    onClick={handleRefreshPrs}
                    disabled={refreshingPrs}
                    title="Refetch PR status from GitHub (gh)"
                  >
                    {refreshingPrs ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <RotateCw size={12} />
                    )}
                  </button>
                }
              >
                <div className="flex flex-col gap-2">
                  {prError && (
                    <div className="alert alert-error alert-soft text-xs py-1.5 px-2 whitespace-pre-wrap">
                      {prError}
                    </div>
                  )}
                  {meta!.prs.map((pr, i) => (
                    <PrRow key={pr.url || i} pr={pr} />
                  ))}
                </div>
              </Section>
            )}

            {meta!.hasTasks && (
              <Section icon={<CheckSquare size={14} />} title="Tasks" count={meta!.tasks.length}>
                <div className="flex flex-col gap-2">
                  {meta!.tasks.map((task, i) => (
                    <TaskRow key={task.url || i} task={task} />
                  ))}
                </div>
              </Section>
            )}

            {meta!.hasEnvs && (
              <Section icon={<Server size={14} />} title="Environments" count={meta!.envs.length}>
                <div className="flex flex-col gap-2">
                  {meta!.envs.map((env, i) => (
                    <EnvRow key={env.path || env.url || i} env={env} onGoToWorktree={onGoToWorktree} />
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectOverviewTab;
