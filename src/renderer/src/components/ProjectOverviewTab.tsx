import React from "react";
import { RotateCw, Star, GitPullRequest, CheckSquare } from "lucide-react";
import type { ProjectMetadata, ProjectPr, ProjectTask } from "../../../shared/protocol";

interface ProjectOverviewTabProps {
  meta: ProjectMetadata | null;
  loading: boolean;
  onRefresh: () => void;
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

const ProjectOverviewTab: React.FC<ProjectOverviewTabProps> = ({ meta, loading, onRefresh }) => {
  const hasAnyFiles = meta && (meta.hasProjectMd || meta.hasPrs || meta.hasTasks);

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
            No project files found. Add a PROJECT.md (with notion/linear frontmatter), prs.yml, or tasks.yml to this
            directory.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {meta!.title && <h3 className="text-base font-semibold m-0">{meta!.title}</h3>}

            {meta!.hasPrs && (
              <section>
                <div className="flex items-center gap-1.5 mb-2 text-sm font-semibold text-base-content/70">
                  <GitPullRequest size={14} /> PRs{meta!.prs.length > 0 ? ` (${meta!.prs.length})` : ""}
                </div>
                {meta!.prs.length === 0 ? (
                  <p className="text-xs text-base-content/40">None.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {meta!.prs.map((pr, i) => (
                      <PrRow key={pr.url || i} pr={pr} />
                    ))}
                  </div>
                )}
              </section>
            )}

            {meta!.hasTasks && (
              <section>
                <div className="flex items-center gap-1.5 mb-2 text-sm font-semibold text-base-content/70">
                  <CheckSquare size={14} /> Tasks{meta!.tasks.length > 0 ? ` (${meta!.tasks.length})` : ""}
                </div>
                {meta!.tasks.length === 0 ? (
                  <p className="text-xs text-base-content/40">None.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {meta!.tasks.map((task, i) => (
                      <TaskRow key={task.url || i} task={task} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectOverviewTab;
