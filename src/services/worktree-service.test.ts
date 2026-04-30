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
  findParentBranch,
  getBranchDiff,
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

// --- findParentBranch ---

describe("findParentBranch", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns the branch that current branch forked from", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "feature-a"]);
    await fs.writeFile(path.join(repoPath, "a.txt"), "a");
    await git.add("a.txt");
    await git.commit("commit on feature-a");

    await git.checkout(["-b", "feature-b"]);
    await fs.writeFile(path.join(repoPath, "b.txt"), "b");
    await git.add("b.txt");
    await git.commit("commit on feature-b");

    const parent = await findParentBranch(git, "feature-b", "main");
    expect(parent).toBe("feature-a");
  });

  it("returns main when branch was created directly from main", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "feature-a"]);
    await fs.writeFile(path.join(repoPath, "a.txt"), "a");
    await git.add("a.txt");
    await git.commit("commit on feature-a");

    const parent = await findParentBranch(git, "feature-a", "main");
    expect(parent).toBe("main");
  });

  it("returns the closest branch in a chain", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "branch-1"]);
    await fs.writeFile(path.join(repoPath, "1.txt"), "1");
    await git.add("1.txt");
    await git.commit("commit 1");

    await git.checkout(["-b", "branch-2"]);
    await fs.writeFile(path.join(repoPath, "2.txt"), "2");
    await git.add("2.txt");
    await git.commit("commit 2");

    await git.checkout(["-b", "branch-3"]);
    await fs.writeFile(path.join(repoPath, "3.txt"), "3");
    await git.add("3.txt");
    await git.commit("commit 3");

    const parent = await findParentBranch(git, "branch-3", "main");
    expect(parent).toBe("branch-2");
  });

  it("falls back to resolvedMain when no other branch is found", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    // Detach HEAD and make a commit with no branch pointing at the parent
    const headCommit = (await git.raw(["rev-parse", "HEAD"])).trim();
    await git.checkout(["-b", "orphan-like"]);
    await fs.writeFile(path.join(repoPath, "o.txt"), "o");
    await git.add("o.txt");
    await git.commit("orphan commit");

    // Delete main so no branch points at headCommit
    await git.raw(["branch", "-D", "main"]);

    const parent = await findParentBranch(git, "orphan-like", "main");
    expect(parent).toBe("main");
  });
});

// --- getBranchDiff ---

describe("getBranchDiff", () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("diffs against parent branch, not main", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    // Create feature-a with a commit
    await git.checkout(["-b", "feature-a"]);
    await fs.writeFile(path.join(repoPath, "a.txt"), "a");
    await git.add("a.txt");
    await git.commit("commit on feature-a");

    // Create feature-b off feature-a with its own commit
    await git.checkout(["-b", "feature-b"]);
    await fs.writeFile(path.join(repoPath, "b.txt"), "b");
    await git.add("b.txt");
    await git.commit("commit on feature-b");

    const result = await getBranchDiff(repoPath, repoPath, "main");
    // Should only contain b.txt (diff against feature-a), not a.txt
    expect(result.diff).toContain("b.txt");
    expect(result.diff).not.toContain("a.txt");
  });

  it("includes untracked files in the diff", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "feature-a"]);
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "hello");

    const result = await getBranchDiff(repoPath, repoPath, "main");
    expect(result.diff).toContain("untracked.txt");
  });

  it("skips untracked directories instead of expanding them", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "feature-a"]);
    // Create a directory with many untracked files
    const dirPath = path.join(repoPath, "big-output");
    await fs.mkdir(dirPath);
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(dirPath, `file-${i}.txt`), `content-${i}`);
    }

    const result = await getBranchDiff(repoPath, repoPath, "main");
    // The directory's files should not appear individually in the diff
    // because --directory collapses them and dirs are skipped
    expect(result.diff).not.toContain("file-0.txt");
  });

  it("sets truncated when untracked dirs are skipped", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const git = simpleGit(repoPath);

    await git.checkout(["-b", "feature-a"]);
    const dirPath = path.join(repoPath, "output");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "f.txt"), "x");

    const result = await getBranchDiff(repoPath, repoPath, "main");
    // Directory entry is skipped, so truncated should be set
    expect(result.truncated).toBe(true);
  });
});
