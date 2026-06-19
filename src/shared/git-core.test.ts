import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleGit } from "simple-git";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import {
  releaseWorktree,
  claimWorktree,
  extractWorktreeName,
  isTmpBranch,
  getLocalBranchName,
  parseWorktreeList,
  parseWorktreeListOutput,
  branchExists,
  checkBranchMerged,
  getWorktreeStatus,
  removeWorktree,
  stashChanges,
  cleanChanges,
  commitChanges,
} from "./git-core.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "many-test-"));
}

// Git triggers a detached background `gc`/`maintenance` process after pushes and
// commits. That process keeps writing into `objects/` after the awaited git
// command returns, racing afterEach cleanup and causing intermittent
// "ENOTEMPTY: directory not empty" on `objects`. Disabling auto maintenance
// stops the background process from being spawned.
async function disableBackgroundMaintenance(git: ReturnType<typeof simpleGit>): Promise<void> {
  await git.addConfig("gc.auto", "0");
  await git.addConfig("maintenance.auto", "false");
  await git.addConfig("receive.autogc", "0");
}

async function initBareOriginAndClone(
  tmpDir: string
): Promise<{ originPath: string; repoPath: string }> {
  const originPath = path.join(tmpDir, "origin.git");
  const repoPath = path.join(tmpDir, "repo");

  // Create a bare origin repo with an initial commit
  await fs.mkdir(originPath, { recursive: true });
  const originGit = simpleGit(originPath);
  await originGit.init(true);
  await disableBackgroundMaintenance(originGit);

  // Clone it to get a working repo
  await simpleGit(tmpDir).clone(originPath, "repo");

  // Make an initial commit so main exists
  const repoGit = simpleGit(repoPath);
  await disableBackgroundMaintenance(repoGit);
  await fs.writeFile(path.join(repoPath, "file.txt"), "initial");
  await repoGit.add("file.txt");
  await repoGit.commit("initial commit");
  await repoGit.push("origin", "main");

  return { originPath, repoPath };
}

// --- Pure utility tests ---

describe("extractWorktreeName", () => {
  it("strips repo name prefix from worktree dir", () => {
    expect(extractWorktreeName("/tmp/myrepo-wt1", "/home/user/myrepo")).toBe(
      "wt1"
    );
  });

  it("returns full dir name when it does not start with repo name", () => {
    expect(
      extractWorktreeName("/tmp/other-wt1", "/home/user/myrepo")
    ).toBe("other-wt1");
  });

  it("handles repo name that is a prefix of worktree name", () => {
    expect(
      extractWorktreeName("/worktrees/app-feature-auth", "/repos/app")
    ).toBe("feature-auth");
  });
});

describe("isTmpBranch", () => {
  it("returns true for tmp- prefixed branches", () => {
    expect(isTmpBranch("tmp-wt1")).toBe(true);
  });

  it("returns true for refs/heads/tmp- branches", () => {
    expect(isTmpBranch("refs/heads/tmp-wt1")).toBe(true);
  });

  it("returns false for regular branches", () => {
    expect(isTmpBranch("feature-1")).toBe(false);
    expect(isTmpBranch("main")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isTmpBranch(null)).toBe(false);
    expect(isTmpBranch(undefined)).toBe(false);
  });
});

describe("getLocalBranchName", () => {
  it("strips refs/heads/ prefix", () => {
    expect(getLocalBranchName("refs/heads/main")).toBe("main");
    expect(getLocalBranchName("refs/heads/feature-1")).toBe("feature-1");
  });

  it("returns branch name unchanged if no prefix", () => {
    expect(getLocalBranchName("main")).toBe("main");
  });

  it("returns (detached) for null", () => {
    expect(getLocalBranchName(null)).toBe("(detached)");
  });
});

// --- Git integration tests ---

describe("parseWorktreeList", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lists the main worktree and added worktrees", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "feature-1", wtPath]);

    const worktrees = await parseWorktreeList(repoPath);

    // Git resolves symlinks (e.g. /var -> /private/var on macOS)
    const realRepoPath = await fs.realpath(repoPath);
    const realWtPath = await fs.realpath(wtPath);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].path).toBe(realRepoPath);
    expect(worktrees[0].branch).toBe("refs/heads/main");
    expect(worktrees[1].path).toBe(realWtPath);
    expect(worktrees[1].branch).toBe("refs/heads/feature-1");
  });
});

describe("branchExists", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("returns true for existing branches", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    expect(await branchExists(repoPath, "main")).toBe(true);
  });

  it("returns false for non-existent branches", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    expect(await branchExists(repoPath, "no-such-branch")).toBe(false);
  });
});

describe("checkBranchMerged", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reports a branch with no extra commits as fully merged", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    // Create a branch at the same commit as main
    await repoGit.checkout(["-b", "no-changes"]);
    await repoGit.checkout("main");

    const result = await checkBranchMerged(repoPath, "no-changes", "main");
    expect(result.isFullyMerged).toBe(true);
  });

  it("reports a branch with unmerged commits as not fully merged", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    await repoGit.checkout(["-b", "has-changes"]);
    await fs.writeFile(path.join(repoPath, "extra.txt"), "extra");
    await repoGit.add("extra.txt");
    await repoGit.commit("extra commit");
    await repoGit.checkout("main");

    const result = await checkBranchMerged(repoPath, "has-changes", "main");
    expect(result.isFullyMerged).toBe(false);
  });
});

describe("getWorktreeStatus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reports clean status when there are no changes", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(false);
    expect(status.hasStaged).toBe(false);
  });

  it("detects untracked files", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    await fs.writeFile(path.join(repoPath, "untracked.txt"), "hello");

    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(true);
    expect(status.not_added).toContain("untracked.txt");
  });

  it("detects modified files", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    await fs.writeFile(path.join(repoPath, "file.txt"), "modified");

    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(true);
    expect(status.modified).toContain("file.txt");
  });

  it("detects staged files", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);
    await fs.writeFile(path.join(repoPath, "file.txt"), "staged");
    await repoGit.add("file.txt");

    const status = await getWorktreeStatus(repoPath);
    expect(status.hasStaged).toBe(true);
    expect(status.staged).toContain("file.txt");
  });
});

describe("stashChanges", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("stashes modified and untracked files", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    await fs.writeFile(path.join(repoPath, "file.txt"), "modified");
    await fs.writeFile(path.join(repoPath, "new.txt"), "untracked");

    await stashChanges(repoPath, "test stash");

    // Working tree should be clean
    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(false);

    // Stash should exist
    const stashList = await repoGit.stashList();
    expect(stashList.total).toBeGreaterThan(0);
  });
});

describe("cleanChanges", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("discards modified files and deletes untracked files", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);

    await fs.writeFile(path.join(repoPath, "file.txt"), "modified");
    await fs.writeFile(path.join(repoPath, "new.txt"), "untracked");

    await cleanChanges(repoPath);

    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(false);

    // Original file should be restored
    const content = await fs.readFile(path.join(repoPath, "file.txt"), "utf8");
    expect(content).toBe("initial");

    // Untracked file should be gone
    await expect(
      fs.access(path.join(repoPath, "new.txt"))
    ).rejects.toThrow();
  });
});

describe("commitChanges", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("stages all changes and creates a commit", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    await fs.writeFile(path.join(repoPath, "new.txt"), "new file");

    await commitChanges(repoPath, "add new file");

    const log = await repoGit.log({ maxCount: 1 });
    expect(log.latest?.message).toBe("add new file");

    const status = await getWorktreeStatus(repoPath);
    expect(status.hasChanges).toBe(false);
  });
});

describe("removeWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("removes a worktree directory and cleans up git references", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "feature-1", wtPath]);

    // Verify worktree exists
    let worktrees = await parseWorktreeList(repoPath);
    expect(worktrees).toHaveLength(2);

    await removeWorktree(repoPath, wtPath);

    // Directory should be gone
    await expect(fs.access(wtPath)).rejects.toThrow();

    // Git should no longer list it
    worktrees = await parseWorktreeList(repoPath);
    expect(worktrees).toHaveLength(1);
  });
});

describe("claimWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("creates a new branch from main when branch does not exist", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "tmp-wt1", wtPath]);

    const result = await claimWorktree(repoPath, wtPath, "new-feature", "main");
    expect(result).toBe("new-feature");

    const wtGit = simpleGit(wtPath);
    const status = await wtGit.status();
    expect(status.current).toBe("new-feature");
  });

  it("checks out an existing branch", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    // Create a branch with a commit
    await repoGit.checkout(["-b", "existing-feature"]);
    await fs.writeFile(path.join(repoPath, "feat.txt"), "feature");
    await repoGit.add("feat.txt");
    await repoGit.commit("feature work");
    await repoGit.checkout("main");

    // Add a worktree on a tmp branch
    const wtPath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "tmp-wt1", wtPath]);

    const result = await claimWorktree(
      repoPath,
      wtPath,
      "existing-feature",
      "main"
    );
    expect(result).toBe("existing-feature");

    // Should have the feature commit's file
    const content = await fs.readFile(path.join(wtPath, "feat.txt"), "utf8");
    expect(content).toBe("feature");
  });
});

describe("releaseWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("switches worktree to tmp branch at main head and preserves feature branch", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    // Add a worktree on a feature branch
    const worktreePath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "feature-1", worktreePath]);

    // Make a commit on the feature branch
    const wtGit = simpleGit(worktreePath);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "feature work");
    await wtGit.add("feature.txt");
    await wtGit.commit("feature commit");
    const featureCommit = (await wtGit.raw(["rev-parse", "HEAD"])).trim();

    // Get main head for comparison
    const mainHead = (
      await repoGit.raw(["rev-parse", "origin/main"])
    ).trim();

    // Release the worktree
    const result = await releaseWorktree(repoPath, worktreePath, "main");

    expect(result.previousBranch).toBe("feature-1");
    expect(result.tmpBranch).toBe("tmp-wt1");

    // Worktree should now be on the tmp branch
    const wtStatus = await wtGit.status();
    expect(wtStatus.current).toBe("tmp-wt1");

    // Tmp branch should be at main head
    const tmpBranchCommit = (await wtGit.raw(["rev-parse", "HEAD"])).trim();
    expect(tmpBranchCommit).toBe(mainHead);

    // Feature branch should still point at its original commit
    const featureBranchCommit = (
      await repoGit.raw(["rev-parse", "feature-1"])
    ).trim();
    expect(featureBranchCommit).toBe(featureCommit);
  });

  it("reuses existing tmp branch and resets it to current main head", async () => {
    const { repoPath } = await initBareOriginAndClone(tmpDir);
    const repoGit = simpleGit(repoPath);

    const worktreePath = path.join(tmpDir, "repo-wt1");
    await repoGit.raw(["worktree", "add", "-b", "feature-1", worktreePath]);

    // Release once to create the tmp branch
    await releaseWorktree(repoPath, worktreePath, "main");

    // Claim back (simulate by checking out feature branch again)
    const wtGit = simpleGit(worktreePath);
    await wtGit.checkout("feature-1");

    // Advance main with a new commit
    await fs.writeFile(path.join(repoPath, "new.txt"), "new content");
    await repoGit.add("new.txt");
    await repoGit.commit("advance main");
    await repoGit.push("origin", "main");
    const newMainHead = (
      await repoGit.raw(["rev-parse", "origin/main"])
    ).trim();

    // Release again — tmp branch should be reset to new main head
    const result = await releaseWorktree(repoPath, worktreePath, "main");

    expect(result.tmpBranch).toBe("tmp-wt1");
    const tmpBranchCommit = (await wtGit.raw(["rev-parse", "HEAD"])).trim();
    expect(tmpBranchCommit).toBe(newMainHead);
  });
});

describe("parseWorktreeListOutput", () => {
  it("parses basic porcelain output", () => {
    const output = [
      "worktree /home/user/repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/repo-wt1",
      "HEAD def456",
      "branch refs/heads/feature-1",
      "",
    ].join("\n");

    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: "/home/user/repo",
      commit: "abc123",
      branch: "refs/heads/main",
    });
    expect(result[1]).toEqual({
      path: "/home/user/repo-wt1",
      commit: "def456",
      branch: "refs/heads/feature-1",
    });
  });

  it("parses locked worktrees", () => {
    const output = [
      "worktree /home/user/repo-wt1",
      "HEAD abc123",
      "branch refs/heads/feature-1",
      "locked",
      "",
    ].join("\n");

    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].locked).toBe(true);
  });

  it("parses locked worktrees with a reason", () => {
    const output = [
      "worktree /home/user/repo-wt1",
      "HEAD abc123",
      "branch refs/heads/feature-1",
      "locked reason for locking",
      "",
    ].join("\n");

    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].locked).toBe(true);
  });

  it("parses bare worktrees", () => {
    const output = [
      "worktree /home/user/repo.git",
      "bare",
      "",
    ].join("\n");

    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].bare).toBe(true);
  });

  it("unlocked worktrees do not have locked field", () => {
    const output = [
      "worktree /home/user/repo-wt1",
      "HEAD abc123",
      "branch refs/heads/feature-1",
      "",
    ].join("\n");

    const result = parseWorktreeListOutput(output);
    expect(result[0].locked).toBeUndefined();
  });
});

describe("parseWorktreeList with stale locked worktrees", () => {
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    ({ repoPath } = await initBareOriginAndClone(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("auto-unlocks and prunes a locked worktree whose directory was deleted", async () => {
    const git = simpleGit(repoPath);

    // Create a worktree
    const wtPath = path.join(tmpDir, "repo-wt1");
    await git.raw(["worktree", "add", "-b", "tmp-wt1", wtPath, "main"]);

    // Lock it
    await git.raw(["worktree", "lock", wtPath]);

    // Manually delete the directory (simulating stale state)
    await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    // parseWorktreeList should auto-unlock and prune the stale entry
    const worktrees = await parseWorktreeList(repoPath);

    // Only the main worktree should remain
    expect(worktrees).toHaveLength(1);
    // git resolves symlinks (e.g. /tmp -> /private/tmp on macOS), so just check the basename matches
    expect(path.basename(worktrees[0].path)).toBe(path.basename(repoPath));
  });
});
