import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { createQueryHandlers } from "./rpc-handlers.js";
import type { FsEntry } from "../shared/protocol.js";

// The fs.* handlers do not touch the injected services, so stub them.
const handlers = createQueryHandlers({
  terminalManager: {} as never,
  claudeService: {} as never,
  sessionStore: {} as never,
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
