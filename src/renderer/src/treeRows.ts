import { FileTreeRow } from "./components/FileTree";
import { FsEntry, ProjectEntry } from "./types";
import { WorktreeActivity, isActive } from "./treeActivity";

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");

// Directories before files, then alphabetical.
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) =>
    a.isDirectory === b.isDirectory
      ? a.name.localeCompare(b.name)
      : a.isDirectory
        ? -1
        : 1,
  );
}

// The project that contains `path` (the path itself, or any descendant of it).
function projectFor(projects: ProjectEntry[], path: string): ProjectEntry | undefined {
  const sep = sepOf(path);
  return projects.find((p) => path === p.path || path.startsWith(p.path + sep));
}

// Flatten a forest of root rows into an ordered list, expanding each directory
// in `expanded` to show its cached children recursively. Shared by the Projects
// tree and the Active tree; they differ only in which roots they pass in.
//
// A path is emitted at most once. Roots can nest (a project registered inside
// another project; a folder with a live session whose pinned subfolder is also
// a root). A nested root renders inline under its parent when the chain of
// directories up to that parent is expanded, keeping its own identity (project
// name / isProject); when that chain is collapsed it renders standalone from the
// roots loop instead. Either way it stays browseable under its parent.
export function buildTreeRows(
  roots: FileTreeRow[],
  expanded: Set<string>,
  childrenByDir: Map<string, FsEntry[]>,
): FileTreeRow[] {
  const result: FileTreeRow[] = [];
  const seen = new Set<string>();
  const rootByPath = new Map(roots.map((r) => [r.entry.path, r] as const));
  const emit = (row: FileTreeRow): boolean => {
    if (seen.has(row.entry.path)) return false;
    seen.add(row.entry.path);
    result.push(row);
    return true;
  };
  // Whether `path` is reached by walking down from an ancestor root: every
  // directory from its parent up to (and including) the nearest ancestor root
  // must be expanded. If so it is emitted nested there, so the roots loop skips
  // its standalone row.
  const nestsUnderAncestor = (path: string): boolean => {
    const sep = sepOf(path);
    let cur = path.slice(0, path.lastIndexOf(sep));
    while (cur) {
      if (!expanded.has(cur)) return false;
      if (rootByPath.has(cur)) return true;
      const i = cur.lastIndexOf(sep);
      if (i < 0) return false;
      cur = cur.slice(0, i);
    }
    return false;
  };
  const walk = (dirPath: string, depth: number, project: ProjectEntry | undefined) => {
    const entries = childrenByDir.get(dirPath);
    if (!entries) return;
    for (const entry of entries) {
      // A descendant that is itself a root renders inline here with its own
      // identity (project name / isProject) rather than as a plain child.
      const asRoot = rootByPath.get(entry.path);
      const row: FileTreeRow = asRoot
        ? { entry: asRoot.entry, depth, project: asRoot.project, isProject: asRoot.isProject }
        : { entry, depth, project, isProject: false };
      if (!emit(row)) continue;
      if (entry.isDirectory && expanded.has(entry.path)) {
        walk(entry.path, depth + 1, row.project);
      }
    }
  };
  for (const root of roots) {
    if (nestsUnderAncestor(root.entry.path)) continue;
    if (!emit(root)) continue;
    if (expanded.has(root.entry.path)) walk(root.entry.path, root.depth + 1, root.project);
  }
  return result;
}

// Root rows for the Active tree: every folder with a live session plus every
// pinned folder, deduped and sorted, each tagged with its containing project so
// it behaves exactly like the same node in the Projects tree.
export function activeRoots(
  projects: ProjectEntry[],
  activity: Record<string, WorktreeActivity>,
  pinnedFolders: string[],
): FileTreeRow[] {
  const roots = new Set<string>(pinnedFolders);
  // Activity is reported for every path with a live session, including
  // worktrees that belong to no project. The Active tree on the Projects tab
  // must only surface project-owned paths, so skip activity outside a project.
  for (const [p, a] of Object.entries(activity)) {
    if (isActive(a) && projectFor(projects, p)) roots.add(p);
  }
  return [...roots].sort().map((path) => {
    const owner = projectFor(projects, path);
    const isProject = !!owner && owner.path === path;
    const name = isProject ? owner!.name : path.slice(path.lastIndexOf(sepOf(path)) + 1);
    // A pinned folder outside any registered project is still a browsable root;
    // treat it as its own project root so path operations (expand/collapse, open)
    // resolve. Without this its rows carry no project and the tree handlers,
    // which bail on a missing project, can't toggle or open it.
    const project = owner ?? { name, path, addedAt: "" };
    return {
      entry: { name, path, isDirectory: true },
      depth: 0,
      isProject,
      project,
    };
  });
}
