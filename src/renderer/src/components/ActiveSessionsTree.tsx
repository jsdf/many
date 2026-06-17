import React, { useMemo } from "react";
import { ProjectEntry, ProjectNode } from "../types";
import { WorktreeActivity, sumActivityUnder, isActive } from "../treeActivity";
import TreeRowItem from "./TreeRowItem";

interface ActiveSessionsTreeProps {
  projects: ProjectEntry[];
  worktreeActivity?: Record<string, WorktreeActivity>;
  selectedNode: ProjectNode | null;
  onSelectNode: (node: ProjectNode) => void;
}

interface ActiveRow {
  name: string;
  path: string;
  depth: number;
  isProject: boolean;
}

// Build a folder tree containing only in-use folders and the ancestor chain
// up to each project root that leads to them.
function buildRows(
  projects: ProjectEntry[],
  activity: Record<string, WorktreeActivity>,
): ActiveRow[] {
  const activePaths = Object.entries(activity)
    .filter(([, a]) => isActive(a))
    .map(([p]) => p);

  const rows: ActiveRow[] = [];
  for (const project of projects) {
    const sep = project.path.includes("\\") ? "\\" : "/";
    const under = activePaths.filter(
      (p) => p === project.path || p.startsWith(project.path + sep),
    );
    if (under.length === 0) continue;

    // Every folder to render: each active path plus all its ancestors down
    // from (and including) the project root.
    const included = new Set<string>();
    for (const p of under) {
      let cur = p;
      while (cur.length >= project.path.length) {
        included.add(cur);
        if (cur === project.path) break;
        const i = cur.lastIndexOf(sep);
        if (i < 0) break;
        cur = cur.slice(0, i);
      }
    }

    rows.push({
      name: project.name,
      path: project.path,
      depth: 0,
      isProject: true,
    });
    const emit = (dir: string, depth: number) => {
      const children = [...included]
        .filter((p) => {
          if (p === dir) return false;
          const i = p.lastIndexOf(sep);
          return i >= 0 && p.slice(0, i) === dir;
        })
        .sort();
      for (const child of children) {
        rows.push({
          name: child.slice(child.lastIndexOf(sep) + 1),
          path: child,
          depth,
          isProject: false,
        });
        emit(child, depth + 1);
      }
    };
    emit(project.path, 1);
  }
  return rows;
}

const ActiveSessionsTree: React.FC<ActiveSessionsTreeProps> = ({
  projects,
  worktreeActivity,
  selectedNode,
  onSelectNode,
}) => {
  const rows = useMemo(
    () => (worktreeActivity ? buildRows(projects, worktreeActivity) : []),
    [projects, worktreeActivity],
  );

  if (rows.length === 0) return null;

  return (
    <div className="mb-3 shrink-0">
      <div className="mb-1 px-0.5">
        <span className="text-xs font-semibold text-base-content/60">
          Active
        </span>
      </div>
      <div className="max-h-48 overflow-auto">
        {rows.map((row) => (
          <div key={row.path} style={{ height: 24 }}>
            <TreeRowItem
              name={row.name}
              isDirectory
              isProject={row.isProject}
              depth={row.depth}
              selected={selectedNode?.path === row.path}
              expanded
              title={row.path}
              terminalCount={
                sumActivityUnder(worktreeActivity, row.path).terminals
              }
              onClick={() => onSelectNode({ name: row.name, path: row.path })}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActiveSessionsTree;
