import { describe, it, expect } from "vitest";
import { activeRoots, buildTreeRows } from "./treeRows";
import { FileTreeRow } from "./components/FileTree";
import { ProjectEntry, FsEntry } from "./types";

const projects: ProjectEntry[] = [{ name: "many", path: "/repo", addedAt: "" }];

const projectRoot: FileTreeRow = {
  entry: { name: "many", path: "/repo", isDirectory: true },
  depth: 0,
  isProject: true,
  project: projects[0],
};

describe("activeRoots", () => {
  it("includes folders with live sessions", () => {
    const roots = activeRoots(projects, { "/repo/src": { terminals: 1, claudeSessions: 0, openFiles: 0 } }, []);
    expect(roots.map((r) => r.entry.path)).toEqual(["/repo/src"]);
  });

  it("includes folders active only via open files", () => {
    const roots = activeRoots(projects, { "/repo/src": { terminals: 0, claudeSessions: 0, openFiles: 2 } }, []);
    expect(roots.map((r) => r.entry.path)).toEqual(["/repo/src"]);
  });

  it("excludes active folders that belong to no project (e.g. worktrees)", () => {
    const roots = activeRoots(
      projects,
      {
        "/repo/src": { terminals: 1, claudeSessions: 0, openFiles: 0 },
        "/worktrees/feature": { terminals: 1, claudeSessions: 1, openFiles: 0 },
      },
      [],
    );
    expect(roots.map((r) => r.entry.path)).toEqual(["/repo/src"]);
  });

  it("includes pinned folders even with no sessions", () => {
    const roots = activeRoots(projects, {}, ["/repo/docs"]);
    expect(roots.map((r) => r.entry.path)).toEqual(["/repo/docs"]);
  });

  it("dedupes a folder that is both active and pinned", () => {
    const roots = activeRoots(projects, { "/repo/src": { terminals: 2, claudeSessions: 0, openFiles: 0 } }, ["/repo/src"]);
    expect(roots.filter((r) => r.entry.path === "/repo/src")).toHaveLength(1);
  });

  it("keeps pinned folders first, in their stored order, ahead of active folders", () => {
    const roots = activeRoots(
      projects,
      { "/repo/aaa": { terminals: 1, claudeSessions: 0, openFiles: 0 } },
      ["/repo/zzz", "/repo/mmm"],
    );
    expect(roots.map((r) => r.entry.path)).toEqual(["/repo/zzz", "/repo/mmm", "/repo/aaa"]);
  });

  it("uses the project name and isProject flag for a project root", () => {
    const roots = activeRoots(projects, {}, ["/repo"]);
    expect(roots[0]).toMatchObject({ isProject: true, entry: { name: "many", path: "/repo" } });
  });

  it("tags a subfolder root with its containing project but not isProject", () => {
    const roots = activeRoots(projects, {}, ["/repo/src"]);
    expect(roots[0]).toMatchObject({ isProject: false, project: projects[0] });
    expect(roots[0].entry.name).toBe("src");
  });

  it("treats a pinned folder outside any project as its own root, so it stays toggleable", () => {
    const roots = activeRoots(projects, {}, ["/elsewhere/many"]);
    expect(roots[0]).toMatchObject({ isProject: false });
    expect(roots[0].entry.name).toBe("many");
    // A defined project (rooted at the folder itself) is what lets the tree
    // handlers toggle and open it.
    expect(roots[0].project).toMatchObject({ path: "/elsewhere/many", name: "many" });
  });
});

describe("buildTreeRows", () => {
  it("returns just the roots when nothing is expanded", () => {
    const rows = buildTreeRows([projectRoot], new Set(), new Map());
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo"]);
  });

  it("lists children of an expanded root, inheriting its project", () => {
    const children: FsEntry[] = [
      { name: "sub", path: "/repo/sub", isDirectory: true },
      { name: "b.ts", path: "/repo/b.ts", isDirectory: false },
    ];
    const rows = buildTreeRows(
      [projectRoot],
      new Set(["/repo"]),
      new Map([["/repo", children]]),
    );
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo", "/repo/sub", "/repo/b.ts"]);
    expect(rows.slice(1).every((r) => r.depth === 1 && r.project === projects[0])).toBe(true);
  });

  it("recurses into expanded descendants", () => {
    const childrenByDir = new Map<string, FsEntry[]>([
      ["/repo", [{ name: "src", path: "/repo/src", isDirectory: true }]],
      ["/repo/src", [{ name: "a.ts", path: "/repo/src/a.ts", isDirectory: false }]],
    ]);
    const rows = buildTreeRows([projectRoot], new Set(["/repo", "/repo/src"]), childrenByDir);
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo", "/repo/src", "/repo/src/a.ts"]);
    expect(rows[2].depth).toBe(2);
  });

  it("does not list children of a collapsed directory", () => {
    const childrenByDir = new Map<string, FsEntry[]>([
      ["/repo", [{ name: "src", path: "/repo/src", isDirectory: true }]],
      ["/repo/src", [{ name: "a.ts", path: "/repo/src/a.ts", isDirectory: false }]],
    ]);
    const rows = buildTreeRows([projectRoot], new Set(["/repo"]), childrenByDir);
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo", "/repo/src"]);
  });

  it("renders a nested root inline under its expanded ancestor, once", () => {
    // data-fetching is active and data-fetching/.claude is pinned, so both are
    // roots. Expanding data-fetching renders .claude inline among its files
    // (browseable), not removed from the parent, and never duplicated.
    const roots = activeRoots(projects, {}, ["/repo/a", "/repo/a/b"]);
    const childrenByDir = new Map<string, FsEntry[]>([
      [
        "/repo/a",
        [
          { name: "b", path: "/repo/a/b", isDirectory: true },
          { name: "f.ts", path: "/repo/a/f.ts", isDirectory: false },
        ],
      ],
    ]);
    const rows = buildTreeRows(roots, new Set(["/repo/a"]), childrenByDir);
    const paths = rows.map((r) => r.entry.path);
    expect(paths.filter((p) => p === "/repo/a/b")).toHaveLength(1);
    // /repo/a/b nests under /repo/a (depth 1), in its natural file-tree position.
    expect(paths).toEqual(["/repo/a", "/repo/a/b", "/repo/a/f.ts"]);
    expect(rows.find((r) => r.entry.path === "/repo/a/b")!.depth).toBe(1);
  });

  it("shows a nested root at top level when its ancestor root is collapsed", () => {
    const roots = activeRoots(projects, {}, ["/repo/a", "/repo/a/b"]);
    const rows = buildTreeRows(roots, new Set(), new Map());
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo/a", "/repo/a/b"]);
  });

  it("keeps a nested project browseable under its expanded parent", () => {
    // /repo and /repo/sub are both registered projects (and /repo/sub may also be
    // active or pinned). Expanding /repo must still list /repo/sub among its
    // files, nested, rather than removing it and only showing it standalone.
    const nested: ProjectEntry[] = [
      { name: "many", path: "/repo", addedAt: "" },
      { name: "sub", path: "/repo/sub", addedAt: "" },
    ];
    const roots: FileTreeRow[] = nested.map((project) => ({
      entry: { name: project.name, path: project.path, isDirectory: true },
      depth: 0,
      project,
      isProject: true,
    }));
    const childrenByDir = new Map<string, FsEntry[]>([
      [
        "/repo",
        [
          { name: "sub", path: "/repo/sub", isDirectory: true },
          { name: "readme.md", path: "/repo/readme.md", isDirectory: false },
        ],
      ],
    ]);
    const rows = buildTreeRows(roots, new Set(["/repo"]), childrenByDir);
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo", "/repo/sub", "/repo/readme.md"]);
    const sub = rows.find((r) => r.entry.path === "/repo/sub")!;
    expect(sub.depth).toBe(1);
    // It is still a project node, not a plain subfolder.
    expect(sub.isProject).toBe(true);
    expect(sub.project).toBe(nested[1]);
  });

  it("expands a subfolder root the same way as a project root", () => {
    const [root] = activeRoots(projects, { "/repo/src": { terminals: 1, claudeSessions: 0, openFiles: 0 } }, []);
    const rows = buildTreeRows(
      [root],
      new Set(["/repo/src"]),
      new Map([["/repo/src", [{ name: "a.ts", path: "/repo/src/a.ts", isDirectory: false }]]]),
    );
    expect(rows.map((r) => r.entry.path)).toEqual(["/repo/src", "/repo/src/a.ts"]);
    expect(rows[1].depth).toBe(1);
  });
});
