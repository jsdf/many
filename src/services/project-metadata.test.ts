import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { parseProjectMd, parsePrsYml, parseTasksYml, readProjectMetadata } from "./project-metadata.js";

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

    const meta = await readProjectMetadata(dir);
    expect(meta.title).toBe("My Project");
    expect(meta.links).toEqual([{ key: "linear", value: "https://linear.app/p", isUrl: true }]);
    expect(meta.prs).toHaveLength(1);
    expect(meta.tasks).toHaveLength(1);
    expect(meta).toMatchObject({ hasProjectMd: true, hasPrs: true, hasTasks: true });
  });

  it("distinguishes absent files from empty ones via has* flags", async () => {
    await fs.writeFile(path.join(dir, "prs.yml"), "prs: []");
    const meta = await readProjectMetadata(dir);
    expect(meta.hasProjectMd).toBe(false);
    expect(meta.hasPrs).toBe(true);
    expect(meta.hasTasks).toBe(false);
    expect(meta.prs).toEqual([]);
    expect(meta.links).toEqual([]);
    expect(meta.title).toBeNull();
  });
});
