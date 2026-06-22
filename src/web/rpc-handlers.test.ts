import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { createQueryHandlers, createSubscriptionHandlers } from "./rpc-handlers.js";
import type { FsEntry } from "../shared/protocol.js";

// The fs.* handlers do not touch the injected services, so stub them.
const handlers = createQueryHandlers({
  terminalManager: {} as never,
  claudeService: {} as never,
  sessionStore: {} as never,
  claudeUiService: {} as never,
});

// The fs.* subscription handlers likewise ignore the injected services.
const subHandlers = createSubscriptionHandlers({
  terminalManager: {} as never,
  repoWatcher: {} as never,
  worktreeWatcher: {} as never,
  claudeService: {} as never,
  claudeUiService: {} as never,
});

const listDir = (dirPath: string) =>
  handlers["fs.listDir"]!({ dirPath }) as Promise<FsEntry[]>;
const readFile = (filePath: string) =>
  handlers["fs.readFile"]!({ filePath }) as Promise<{
    content: string;
    size: number;
    tooLarge: boolean;
    binary: boolean;
  }>;
const writeFile = (filePath: string, content: string) =>
  handlers["fs.writeFile"]!({ filePath, content }) as Promise<{ ok: boolean }>;
const createFile = (filePath: string) =>
  handlers["fs.createFile"]!({ filePath }) as Promise<{ ok: boolean }>;
const createDir = (dirPath: string) =>
  handlers["fs.createDir"]!({ dirPath }) as Promise<{ ok: boolean }>;
const rename = (oldPath: string, newPath: string) =>
  handlers["fs.rename"]!({ oldPath, newPath }) as Promise<{ ok: boolean }>;
const remove = (targetPath: string) =>
  handlers["fs.delete"]!({ path: targetPath }) as Promise<{ ok: boolean }>;

// Poll until a condition holds, so fs.watch-driven pushes can be awaited
// without depending on a fixed latency.
async function waitFor(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("terminal.closeWorktree", () => {
  it("kills every session for the worktree and returns the count", async () => {
    const killed: string[] = [];
    const sessionsByPath: Record<string, string[]> = {
      "/repo/a": ["t1", "t2"],
      "/repo/b": ["t3"],
    };
    const fakeTerminalManager = {
      getSessionsForWorktree: (p: string) => sessionsByPath[p] ?? [],
      cleanupWorktree: (p: string) => {
        for (const id of sessionsByPath[p] ?? []) killed.push(id);
      },
    };
    const h = createQueryHandlers({
      terminalManager: fakeTerminalManager as never,
      claudeService: {} as never,
      sessionStore: {} as never,
      claudeUiService: {} as never,
    });
    const res = (await h["terminal.closeWorktree"]!({ worktreePath: "/repo/a" })) as { closed: number };
    expect(res).toEqual({ closed: 2 });
    expect(killed).toEqual(["t1", "t2"]);
  });

  it("returns zero when no sessions match", async () => {
    const fakeTerminalManager = {
      getSessionsForWorktree: () => [],
      cleanupWorktree: () => {},
    };
    const h = createQueryHandlers({
      terminalManager: fakeTerminalManager as never,
      claudeService: {} as never,
      sessionStore: {} as never,
      claudeUiService: {} as never,
    });
    const res = (await h["terminal.closeWorktree"]!({ worktreePath: "/repo/none" })) as { closed: number };
    expect(res).toEqual({ closed: 0 });
  });
});

describe("fs.listDir", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns directories first, then files, each alphabetically", async () => {
    await fs.writeFile(path.join(tmpDir, "b.txt"), "");
    await fs.writeFile(path.join(tmpDir, "a.txt"), "");
    await fs.mkdir(path.join(tmpDir, "zdir"));
    await fs.mkdir(path.join(tmpDir, "adir"));

    const entries = await listDir(tmpDir);

    expect(entries.map((e) => e.name)).toEqual(["adir", "zdir", "a.txt", "b.txt"]);
    expect(entries.map((e) => e.isDirectory)).toEqual([true, true, false, false]);
    expect(entries[0].path).toBe(path.join(tmpDir, "adir"));
  });

  it("throws a descriptive error for a missing directory", async () => {
    await expect(listDir(path.join(tmpDir, "does-not-exist"))).rejects.toThrow(
      /Cannot read directory/
    );
  });
});

describe("fs.readFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a small text file", async () => {
    const file = path.join(tmpDir, "hello.txt");
    await fs.writeFile(file, "hello world");
    const res = await readFile(file);
    expect(res).toMatchObject({ content: "hello world", binary: false, tooLarge: false });
    expect(res.size).toBe(11);
  });

  it("flags files larger than the cap without reading them", async () => {
    const file = path.join(tmpDir, "big.txt");
    await fs.writeFile(file, Buffer.alloc(512 * 1024 + 1, 0x61));
    const res = await readFile(file);
    expect(res.tooLarge).toBe(true);
    expect(res.content).toBe("");
  });

  it("flags binary files via a NUL-byte sniff", async () => {
    const file = path.join(tmpDir, "data.bin");
    await fs.writeFile(file, Buffer.from([0x01, 0x00, 0x02, 0x03]));
    const res = await readFile(file);
    expect(res.binary).toBe(true);
    expect(res.content).toBe("");
  });
});

describe("fs.writeFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes new content that round-trips through readFile", async () => {
    const file = path.join(tmpDir, "note.md");
    const res = await writeFile(file, "# Title\n\nbody\n");
    expect(res).toEqual({ ok: true });
    expect((await readFile(file)).content).toBe("# Title\n\nbody\n");
  });

  it("overwrites existing content", async () => {
    const file = path.join(tmpDir, "existing.txt");
    await fs.writeFile(file, "old");
    await writeFile(file, "new");
    expect((await readFile(file)).content).toBe("new");
  });
});

describe("fs.createFile", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates an empty file", async () => {
    const file = path.join(tmpDir, "new.txt");
    expect(await createFile(file)).toEqual({ ok: true });
    expect((await readFile(file)).content).toBe("");
  });

  it("refuses to clobber an existing file", async () => {
    const file = path.join(tmpDir, "keep.txt");
    await fs.writeFile(file, "precious");
    await expect(createFile(file)).rejects.toThrow(/Cannot create file/);
    // The original content must survive.
    expect((await readFile(file)).content).toBe("precious");
  });
});

describe("fs.createDir", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a directory", async () => {
    const dir = path.join(tmpDir, "sub");
    expect(await createDir(dir)).toEqual({ ok: true });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("errors if the directory already exists", async () => {
    const dir = path.join(tmpDir, "sub");
    await fs.mkdir(dir);
    await expect(createDir(dir)).rejects.toThrow(/Cannot create directory/);
  });
});

describe("fs.rename", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renames a file", async () => {
    const oldPath = path.join(tmpDir, "old.txt");
    const newPath = path.join(tmpDir, "new.txt");
    await fs.writeFile(oldPath, "data");
    expect(await rename(oldPath, newPath)).toEqual({ ok: true });
    expect((await readFile(newPath)).content).toBe("data");
    await expect(fs.stat(oldPath)).rejects.toThrow();
  });

  it("renames a directory and its contents", async () => {
    const oldPath = path.join(tmpDir, "olddir");
    const newPath = path.join(tmpDir, "newdir");
    await fs.mkdir(oldPath);
    await fs.writeFile(path.join(oldPath, "child.txt"), "hi");
    await rename(oldPath, newPath);
    expect((await readFile(path.join(newPath, "child.txt"))).content).toBe("hi");
  });

  it("refuses to overwrite an existing destination", async () => {
    const oldPath = path.join(tmpDir, "src.txt");
    const newPath = path.join(tmpDir, "dest.txt");
    await fs.writeFile(oldPath, "src");
    await fs.writeFile(newPath, "dest");
    await expect(rename(oldPath, newPath)).rejects.toThrow(/Destination already exists/);
    // Neither file is touched.
    expect((await readFile(oldPath)).content).toBe("src");
    expect((await readFile(newPath)).content).toBe("dest");
  });

  it("errors when the source is missing", async () => {
    await expect(
      rename(path.join(tmpDir, "nope.txt"), path.join(tmpDir, "dest.txt"))
    ).rejects.toThrow(/Cannot rename/);
  });
});

describe("fs.delete", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes a file", async () => {
    const file = path.join(tmpDir, "gone.txt");
    await fs.writeFile(file, "bye");
    expect(await remove(file)).toEqual({ ok: true });
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("deletes a directory recursively", async () => {
    const dir = path.join(tmpDir, "tree");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(path.join(dir, "nested", "b.txt"), "b");
    await remove(dir);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("errors when the target does not exist", async () => {
    await expect(remove(path.join(tmpDir, "missing"))).rejects.toThrow(/Cannot delete/);
  });
});

describe("fs.dirUpdates", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("pushes the initial listing", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "");
    const pushes: FsEntry[][] = [];
    const cleanup = subHandlers["fs.dirUpdates"]!({ dirPath: tmpDir }, (v) => pushes.push(v as FsEntry[]));
    await waitFor(() => pushes.length > 0);
    expect(pushes[0].map((e) => e.name)).toEqual(["a.txt"]);
    (cleanup as () => void)();
  });

  it("re-reads and pushes when a file is added", async () => {
    const pushes: FsEntry[][] = [];
    const cleanup = subHandlers["fs.dirUpdates"]!({ dirPath: tmpDir }, (v) => pushes.push(v as FsEntry[]));
    await waitFor(() => pushes.length > 0);
    await fs.writeFile(path.join(tmpDir, "added.txt"), "");
    await waitFor(() => pushes.some((p) => p.some((e) => e.name === "added.txt")));
    (cleanup as () => void)();
  });

  it("stops pushing after cleanup", async () => {
    const pushes: FsEntry[][] = [];
    const cleanup = subHandlers["fs.dirUpdates"]!({ dirPath: tmpDir }, (v) => pushes.push(v as FsEntry[]));
    await waitFor(() => pushes.length > 0);
    (cleanup as () => void)();
    const countAfterCleanup = pushes.length;
    await fs.writeFile(path.join(tmpDir, "ignored.txt"), "");
    await new Promise((r) => setTimeout(r, 400));
    expect(pushes.length).toBe(countAfterCleanup);
  });
});

describe("fs.fileUpdates", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "many-fs-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  type FileUpdate = { content: string; size: number; tooLarge: boolean; binary: boolean };

  it("pushes the initial file content", async () => {
    const file = path.join(tmpDir, "watch.txt");
    await fs.writeFile(file, "initial");
    const pushes: FileUpdate[] = [];
    const cleanup = subHandlers["fs.fileUpdates"]!({ filePath: file }, (v) => pushes.push(v as FileUpdate));
    await waitFor(() => pushes.length > 0);
    expect(pushes[0].content).toBe("initial");
    (cleanup as () => void)();
  });

  it("pushes new content when the file changes on disk", async () => {
    const file = path.join(tmpDir, "watch.txt");
    await fs.writeFile(file, "before");
    const pushes: FileUpdate[] = [];
    const cleanup = subHandlers["fs.fileUpdates"]!({ filePath: file }, (v) => pushes.push(v as FileUpdate));
    await waitFor(() => pushes.length > 0);
    await fs.writeFile(file, "after");
    await waitFor(() => pushes.some((p) => p.content === "after"));
    (cleanup as () => void)();
  });

  it("stops pushing after cleanup", async () => {
    const file = path.join(tmpDir, "watch.txt");
    await fs.writeFile(file, "before");
    const pushes: FileUpdate[] = [];
    const cleanup = subHandlers["fs.fileUpdates"]!({ filePath: file }, (v) => pushes.push(v as FileUpdate));
    await waitFor(() => pushes.length > 0);
    (cleanup as () => void)();
    const countAfterCleanup = pushes.length;
    await fs.writeFile(file, "after");
    await new Promise((r) => setTimeout(r, 400));
    expect(pushes.length).toBe(countAfterCleanup);
  });
});
