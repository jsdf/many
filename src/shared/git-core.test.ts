import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleGit } from "simple-git";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { releaseWorktree } from "./git-core.js";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "many-test-"));
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

  // Clone it to get a working repo
  await simpleGit(tmpDir).clone(originPath, "repo");

  // Make an initial commit so main exists
  const repoGit = simpleGit(repoPath);
  await fs.writeFile(path.join(repoPath, "file.txt"), "initial");
  await repoGit.add("file.txt");
  await repoGit.commit("initial commit");
  await repoGit.push("origin", "main");

  return { originPath, repoPath };
}

describe("releaseWorktree", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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
