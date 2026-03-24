import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { simpleGit } from "simple-git";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  resolveStartingPoint,
  archiveWorktree,
  createAndSetupWorktree,
  launchTask,
} from "./worktree-service.js";
import type { ProgressEvent, RunCommand } from "./types.js";
import { parseWorktreeList } from "../shared/git-core.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "many-svc-test-"));
}

async function initBareOriginAndClone(
  tmpDir: string
): Promise<{ originPath: string; repoPath: string }> {
  const originPath = path.join(tmpDir, "origin.git");
  const repoPath = path.join(tmpDir, "repo");

  await fs.mkdir(originPath, { recursive: true });
  const originGit = simpleGit(originPath);
  await originGit.init(true);

  await simpleGit(tmpDir).clone(originPath, "repo");

  const repoGit = simpleGit(repoPath);
  await fs.writeFile(path.join(repoPath, "file.txt"), "initial");
  await repoGit.add("file.txt");
  await repoGit.commit("initial commit");
  await repoGit.push("origin", "main");

  return { originPath, repoPath };
}

function collectProgress(): { events: ProgressEvent[]; onProgress: (e: ProgressEvent) => void } {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}

const noopRunCommand: RunCommand = async () => 0;

// --- resolveStartingPoint ---

describe("resolveStartingPoint", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns a plain branch name as-is after fetching", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    await repoGit.checkout(["-b", "feature-x"]);
    await fs.writeFile(path.join(repoPath, "x.txt"), "x");
    await repoGit.add("x.txt");
    await repoGit.commit("add x");
    await repoGit.push("origin", "feature-x");
    await repoGit.checkout("main");

    const branch = await resolveStartingPoint(repoPath, "feature-x");
    expect(branch).toBe("feature-x");
  });

  it("falls back to local branch if remote fetch fails", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    // Create a local-only branch
    await repoGit.checkout(["-b", "local-only"]);
    await repoGit.checkout("main");

    const { events, onProgress } = collectProgress();
    const branch = await resolveStartingPoint(repoPath, "local-only", onProgress);
    expect(branch).toBe("local-only");
    expect(events.some((e) => e.type === "step" && e.text.includes("local branch"))).toBe(true);
  });

  it("throws if branch is not found locally or remotely", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    await expect(resolveStartingPoint(repoPath, "no-such-branch")).rejects.toThrow(
      "not found locally or on remote"
    );
  });
});

// --- archiveWorktree ---

describe("archiveWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("removes the worktree directory and git reference", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "feature-1", wtPath]);

    await archiveWorktree(repoPath, wtPath, { force: true });

    await expect(fs.access(wtPath)).rejects.toThrow();
    const worktrees = await parseWorktreeList(repoPath);
    expect(worktrees.every((w) => w.path !== wtPath)).toBe(true);
  });

  it("throws UNMERGED_BRANCH when branch has unmerged commits", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "unmerged-feature", wtPath]);

    const wtGit = simpleGit(wtPath);
    await fs.writeFile(path.join(wtPath, "feat.txt"), "feature");
    await wtGit.add("feat.txt");
    await wtGit.commit("feature commit");

    await expect(
      archiveWorktree(repoPath, wtPath, { force: false, mainBranch: "main" })
    ).rejects.toThrow("UNMERGED_BRANCH:");
  });

  it("succeeds without error when branch is fully merged", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    const wtPath = path.join(tmpDir, "repo-wt1");
    // Create a branch at the same commit as main (already "merged")
    await repoGit.raw(["worktree", "add", "-b", "merged-feature", wtPath]);

    await expect(
      archiveWorktree(repoPath, wtPath, { force: false, mainBranch: "main" })
    ).resolves.toBeUndefined();

    await expect(fs.access(wtPath)).rejects.toThrow();
  });
});

// --- createAndSetupWorktree ---

describe("createAndSetupWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("creates a worktree on a tmp branch", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);

    const result = await createAndSetupWorktree(repoPath, {
      worktreeName: "wt1",
      mainBranch: "main",
      worktreeDirectory: tmpDir,
    });

    expect(result.branch).toBe("tmp-wt1");
    const stat = await fs.stat(result.worktreePath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("checks out an existing branch when startingPoint is given", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    await repoGit.checkout(["-b", "feature-sp"]);
    await fs.writeFile(path.join(repoPath, "sp.txt"), "sp");
    await repoGit.add("sp.txt");
    await repoGit.commit("sp commit");
    await repoGit.push("origin", "feature-sp");
    await repoGit.checkout("main");

    const result = await createAndSetupWorktree(repoPath, {
      worktreeName: "wt1",
      startingPoint: "feature-sp",
      mainBranch: "main",
      worktreeDirectory: tmpDir,
    });

    expect(result.branch).toBe("feature-sp");
    const content = await fs.readFile(path.join(result.worktreePath, "sp.txt"), "utf8");
    expect(content).toBe("sp");
  });

  it("calls runCommand for the init command and reports progress", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const { events, onProgress } = collectProgress();
    let commandRan = false;
    const runCommand: RunCommand = async (cmd, cwd) => {
      commandRan = true;
      expect(cmd).toBe("echo hello");
      return 0;
    };

    await createAndSetupWorktree(
      repoPath,
      {
        worktreeName: "wt1",
        initCommand: "echo hello",
        mainBranch: "main",
        worktreeDirectory: tmpDir,
      },
      onProgress,
      runCommand
    );

    expect(commandRan).toBe(true);
    expect(events.some((e) => e.type === "step" && e.text.includes("Init command completed"))).toBe(true);
  });

  it("reports non-zero init exit as a step but does not throw", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const { events, onProgress } = collectProgress();
    const runCommand: RunCommand = async () => 1;

    await expect(
      createAndSetupWorktree(
        repoPath,
        {
          worktreeName: "wt1",
          initCommand: "false",
          mainBranch: "main",
          worktreeDirectory: tmpDir,
        },
        onProgress,
        runCommand
      )
    ).resolves.toBeDefined();

    expect(events.some((e) => e.type === "step" && e.text.includes("continuing anyway"))).toBe(true);
  });

  it("prepends poolPrefix to worktree name", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);

    const result = await createAndSetupWorktree(repoPath, {
      worktreeName: "wt1",
      poolPrefix: "pool",
      mainBranch: "main",
      worktreeDirectory: tmpDir,
    });

    expect(result.branch).toBe("tmp-pool-wt1");
  });
});

// --- launchTask ---

describe("launchTask", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("claims an available worktree in a recyclable pool", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    // Create a pool worktree on a tmp branch
    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "tmp-wt1", wtPath]);

    const result = await launchTask(
      repoPath,
      {
        poolType: "recyclable",
        poolPrefix: "wt",
        prompt: "do the thing",
        mainBranch: "main",
        worktreeDirectory: tmpDir,
        launchedBy: "cli",
      },
      undefined,
      noopRunCommand
    );

    expect(result.worktreePath).toBe(await fs.realpath(wtPath));
    // Branch should be claimed (not tmp-)
    const wtGit = simpleGit(wtPath);
    const status = await wtGit.status();
    expect(status.current?.startsWith("tmp-")).toBe(false);
    // Task record registered
    expect(result.taskRecord.id).toBeTruthy();
    expect(result.taskRecord.launchedBy).toBe("cli");
  });

  it("throws if no available worktree in recyclable pool", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);

    await expect(
      launchTask(
        repoPath,
        {
          poolType: "recyclable",
          poolPrefix: "wt",
          prompt: "do the thing",
          mainBranch: "main",
          worktreeDirectory: tmpDir,
          launchedBy: "cli",
        },
        undefined,
        noopRunCommand
      )
    ).rejects.toThrow("No available worktrees");
  });

  it("creates a new ephemeral worktree", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);

    const result = await launchTask(
      repoPath,
      {
        poolType: "ephemeral",
        poolPrefix: "eph",
        prompt: "ephemeral task",
        mainBranch: "main",
        worktreeDirectory: tmpDir,
        launchedBy: "web",
      },
      undefined,
      noopRunCommand
    );

    const stat = await fs.stat(result.worktreePath);
    expect(stat.isDirectory()).toBe(true);
    expect(result.taskRecord.launchedBy).toBe("web");
  });

  it("runs maintenance command in recyclable pool", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "tmp-wt1", wtPath]);

    let maintenanceCwd = "";
    const runCommand: RunCommand = async (cmd, cwd) => {
      maintenanceCwd = cwd;
      return 0;
    };

    await launchTask(
      repoPath,
      {
        poolType: "recyclable",
        poolPrefix: "wt",
        prompt: "test",
        maintenanceCommand: "echo maintain",
        mainBranch: "main",
        worktreeDirectory: tmpDir,
        launchedBy: "cli",
      },
      undefined,
      runCommand
    );

    expect(maintenanceCwd).toBe(await fs.realpath(wtPath));
  });
});
