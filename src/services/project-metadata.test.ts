import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  parseProjectMd,
  parsePrsYml,
  parseTasksYml,
  parseEnvsYml,
  readProjectMetadata,
  ghStateToStatus,
  refreshPrsYml,
} from "./project-metadata.js";

describe("parseProjectMd", () => {
  it("turns URL frontmatter values into openable links and skips empty ones", () => {
    const md = [
      "---",
      "notion: https://notion.so/abc",
      "linear: https://linear.app/clay/project/xyz",
      'github: ""',
      "---",
      "# Fix Agent",
      "",
      "**Goal:** Fix bugs.",
    ].join("\n");

    const { title, links } = parseProjectMd(md);
    expect(title).toBe("Fix Agent");
    expect(links).toEqual([
      { key: "notion", value: "https://notion.so/abc", isUrl: true },
      { key: "linear", value: "https://linear.app/clay/project/xyz", isUrl: true },
    ]);
  });

  it("keeps non-URL scalar values as non-openable links (e.g. local repo)", () => {
    const md = ["---", "local repo: ~/code/alert-agent", "---", "# Title"].join("\n");
    const { links } = parseProjectMd(md);
    expect(links).toEqual([{ key: "local repo", value: "~/code/alert-agent", isUrl: false }]);
  });

  it("returns no links and no title when there is no frontmatter", () => {
    expect(parseProjectMd("# Just a heading\n\nbody")).toEqual({ title: "Just a heading", links: [] });
  });

  it("tolerates malformed frontmatter without throwing", () => {
    const md = "---\n: : bad yaml :\n---\n# T";
    expect(() => parseProjectMd(md)).not.toThrow();
  });
});

describe("parsePrsYml", () => {
  it("parses the env-jsdf prs schema", () => {
    const yml = [
      "prs:",
      "  - url: https://github.com/clay-run/clay-base/pull/40984",
      '    title: "refactor: relocate swr"',
      "    branch: jsdf/data-fetching/relocate-swr-impl",
      "    status: open",
      '    notes: "base of the stack"',
    ].join("\n");

    expect(parsePrsYml(yml)).toEqual([
      {
        url: "https://github.com/clay-run/clay-base/pull/40984",
        title: "refactor: relocate swr",
        branch: "jsdf/data-fetching/relocate-swr-impl",
        status: "open",
        notes: "base of the stack",
      },
    ]);
  });

  it("returns an empty array for the empty sentinel `prs: []`", () => {
    expect(parsePrsYml("prs: []")).toEqual([]);
  });

  it("omits optional fields that are absent", () => {
    expect(parsePrsYml("prs:\n  - url: https://x/pull/1")).toEqual([
      { url: "https://x/pull/1", title: undefined, branch: undefined, status: undefined, notes: undefined },
    ]);
  });
});

describe("parseTasksYml", () => {
  it("parses tasks with focused flag", () => {
    const yml = [
      "tasks:",
      "  - url: https://linear.app/clay/issue/FRO-1591/ship",
      '    title: "Ship migration"',
      "    status: in-progress",
      "    focused: true",
    ].join("\n");

    expect(parseTasksYml(yml)).toEqual([
      {
        url: "https://linear.app/clay/issue/FRO-1591/ship",
        title: "Ship migration",
        status: "in-progress",
        focused: true,
        notes: undefined,
      },
    ]);
  });

  it("defaults focused to false when absent", () => {
    expect(parseTasksYml("tasks:\n  - url: https://linear.app/x")[0].focused).toBe(false);
  });

  it("returns an empty array for `tasks: []`", () => {
    expect(parseTasksYml("tasks: []")).toEqual([]);
  });
});

describe("parseEnvsYml", () => {
  it("parses worktree and cloud-session entries", () => {
    const yml = [
      "envs:",
      "  - kind: worktree",
      "    repo: clay-base",
      "    path: /Users/jsdf/code/many/wt-03",
      "    branch: jsdf/feature",
      "  - kind: ona",
      "    url: https://app.gitpod.io/details/abc",
      '    notes: "cloud run"',
    ].join("\n");

    expect(parseEnvsYml(yml)).toEqual([
      {
        kind: "worktree",
        repo: "clay-base",
        path: "/Users/jsdf/code/many/wt-03",
        branch: "jsdf/feature",
        url: undefined,
        notes: undefined,
      },
      {
        kind: "ona",
        repo: undefined,
        path: undefined,
        branch: undefined,
        url: "https://app.gitpod.io/details/abc",
        notes: "cloud run",
      },
    ]);
  });

  it("returns an empty array for `envs: []`", () => {
    expect(parseEnvsYml("envs: []")).toEqual([]);
  });
});

describe("ghStateToStatus", () => {
  it("maps gh state + draft flag to the prs.yml vocabulary", () => {
    expect(ghStateToStatus("MERGED", false)).toBe("merged");
    expect(ghStateToStatus("CLOSED", false)).toBe("closed");
    expect(ghStateToStatus("OPEN", true)).toBe("draft");
    expect(ghStateToStatus("OPEN", false)).toBe("open");
    // A merged PR was once a draft; merged/closed take precedence over draft.
    expect(ghStateToStatus("MERGED", true)).toBe("merged");
  });
});

describe("refreshPrsYml", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "many-refreshprs-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("updates statuses while preserving comments and notes", async () => {
    const yml = [
      "# stack note",
      "prs:",
      "  - url: https://github.com/clay-run/clay-base/pull/100",
      '    title: "feat: thing"',
      "    status: draft",
      '    notes: "important context"',
      "  - url: https://github.com/clay-run/clay-base/pull/200",
      "    status: open",
      "# trailing comment",
    ].join("\n");
    await fs.writeFile(path.join(dir, "prs.yml"), yml);

    const result = await refreshPrsYml(dir, async (url) =>
      url.endsWith("/100") ? { state: "MERGED", isDraft: false } : { state: "OPEN", isDraft: true }
    );

    expect(result.refreshed).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.metadata.prs.map((p) => p.status)).toEqual(["merged", "draft"]);

    const written = await fs.readFile(path.join(dir, "prs.yml"), "utf-8");
    expect(written).toContain("# stack note");
    expect(written).toContain("# trailing comment");
    expect(written).toContain('notes: "important context"');
    expect(written).toContain("status: merged");
  });

  it("skips non-viewable URLs (create links, non-GitHub hosts)", async () => {
    const yml = [
      "prs:",
      "  - url: https://github.com/clay-run/clay-base/pull/new/my-branch",
      "    status: draft",
      "  - url: https://app.graphite.com/github/clay-run/clay-base/pull/300",
      "    status: open",
    ].join("\n");
    await fs.writeFile(path.join(dir, "prs.yml"), yml);

    const result = await refreshPrsYml(dir, async () => {
      throw new Error("should not be called for skipped URLs");
    });

    expect(result.refreshed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.metadata.prs.map((p) => p.status)).toEqual(["draft", "open"]);
  });

  it("collects per-PR fetch errors without aborting the others", async () => {
    const yml = [
      "prs:",
      "  - url: https://github.com/clay-run/clay-base/pull/1",
      "    status: draft",
      "  - url: https://github.com/clay-run/clay-base/pull/2",
      "    status: draft",
    ].join("\n");
    await fs.writeFile(path.join(dir, "prs.yml"), yml);

    const result = await refreshPrsYml(dir, async (url) => {
      if (url.endsWith("/1")) throw new Error("gh boom");
      return { state: "MERGED", isDraft: false };
    });

    expect(result.refreshed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gh boom");
    expect(result.metadata.prs.map((p) => p.status)).toEqual(["draft", "merged"]);
  });

  it("throws when prs.yml is absent", async () => {
    await expect(refreshPrsYml(dir)).rejects.toThrow(/No prs.yml/);
  });
});

describe("readProjectMetadata", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "many-projmeta-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads all three sidecar files when present", async () => {
    await fs.writeFile(path.join(dir, "PROJECT.md"), "---\nlinear: https://linear.app/p\n---\n# My Project");
    await fs.writeFile(path.join(dir, "prs.yml"), "prs:\n  - url: https://x/pull/1\n    status: open");
    await fs.writeFile(path.join(dir, "tasks.yml"), "tasks:\n  - url: https://linear.app/i\n    focused: true");
    await fs.writeFile(path.join(dir, "envs.yml"), "envs:\n  - kind: worktree\n    path: /tmp/wt-1");

    const meta = await readProjectMetadata(dir);
    expect(meta.title).toBe("My Project");
    expect(meta.links).toEqual([{ key: "linear", value: "https://linear.app/p", isUrl: true }]);
    expect(meta.prs).toHaveLength(1);
    expect(meta.tasks).toHaveLength(1);
    expect(meta.envs).toHaveLength(1);
    expect(meta).toMatchObject({ hasProjectMd: true, hasPrs: true, hasTasks: true, hasEnvs: true });
  });

  it("lists well-known doc files that exist, in canonical order", async () => {
    await fs.writeFile(path.join(dir, "TODO.md"), "- do thing");
    await fs.writeFile(path.join(dir, "PROJECT.md"), "# P");
    await fs.writeFile(path.join(dir, "LEARNINGS.md"), "notes");

    const meta = await readProjectMetadata(dir);
    expect(meta.docs).toEqual(["PROJECT.md", "LEARNINGS.md", "TODO.md"]);
  });

  it("returns no docs when none of the well-known files exist", async () => {
    await fs.writeFile(path.join(dir, "prs.yml"), "prs: []");
    const meta = await readProjectMetadata(dir);
    expect(meta.docs).toEqual([]);
  });

  it("distinguishes absent files from empty ones via has* flags", async () => {
    await fs.writeFile(path.join(dir, "prs.yml"), "prs: []");
    const meta = await readProjectMetadata(dir);
    expect(meta.hasProjectMd).toBe(false);
    expect(meta.hasPrs).toBe(true);
    expect(meta.hasTasks).toBe(false);
    expect(meta.hasEnvs).toBe(false);
    expect(meta.prs).toEqual([]);
    expect(meta.links).toEqual([]);
    expect(meta.title).toBeNull();
  });
});
