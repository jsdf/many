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
export function buildTreeRows(
  roots: FileTreeRow[],
  expanded: Set<string>,
  childrenByDir: Map<string, FsEntry[]>,
): FileTreeRow[] {
  const result: FileTreeRow[] = [];
  const walk = (dirPath: string, depth: number, project: ProjectEntry | undefined) => {
    const entries = childrenByDir.get(dirPath);
    if (!entries) return;
    for (const entry of entries) {
      result.push({ entry, depth, project, isProject: false });
      if (entry.isDirectory && expanded.has(entry.path)) {
        walk(entry.path, depth + 1, project);
      }
    }
  };
  for (const root of roots) {
    result.push(root);
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
  for (const [p, a] of Object.entries(activity)) {
    if (isActive(a)) roots.add(p);
  }
  return [...roots].sort().map((path) => {
    const project = projectFor(projects, path);
    const isProject = !!project && project.path === path;
    return {
      entry: {
        name: isProject ? project!.name : path.slice(path.lastIndexOf(sepOf(path)) + 1),
        path,
        isDirectory: true,
      },
      depth: 0,
      isProject,
      project,
    };
  });
}
