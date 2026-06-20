import { describe, it, expect } from "vitest";
import { WorktreeActivity, sumActivityUnder, isActive } from "./treeActivity";

const act = (o: Partial<WorktreeActivity>): WorktreeActivity => ({
  terminals: 0,
  claudeSessions: 0,
  openFiles: 0,
  ...o,
});

describe("sumActivityUnder", () => {
  it("rolls open files up from descendants to an ancestor", () => {
    const activity = {
      "/repo": act({ openFiles: 1 }),
      "/repo/sub": act({ openFiles: 2, terminals: 1 }),
    };
    expect(sumActivityUnder(activity, "/repo")).toEqual({
      terminals: 1,
      claudeSessions: 0,
      openFiles: 3,
    });
  });

  it("does not let a path absorb a sibling that merely shares a prefix", () => {
    const activity = {
      "/repo": act({ openFiles: 1 }),
      "/repo-2": act({ openFiles: 5 }),
    };
    expect(sumActivityUnder(activity, "/repo").openFiles).toBe(1);
  });
});

describe("isActive", () => {
  it("is active when only open files are present", () => {
    expect(isActive(act({ openFiles: 1 }))).toBe(true);
  });

  it("is inactive when everything is zero", () => {
    expect(isActive(act({}))).toBe(false);
  });
});
