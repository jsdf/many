import { describe, it, expect } from "vitest";
import { cronMatches, isValidCron } from "./cron.js";

// Construct a Date at a known LOCAL time (year, monthIndex, day, hour, minute).
function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("cronMatches", () => {
  it("matches everything with a wildcard expression", () => {
    expect(cronMatches("* * * * *", at(2026, 7, 8, 13, 45))).toBe(true);
  });

  it("matches an exact minute and hour", () => {
    expect(cronMatches("30 9 * * *", at(2026, 7, 8, 9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", at(2026, 7, 8, 9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", at(2026, 7, 8, 10, 30))).toBe(false);
  });

  it("matches inclusive ranges", () => {
    expect(cronMatches("0 9-17 * * *", at(2026, 7, 8, 9, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 7, 8, 17, 0))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at(2026, 7, 8, 8, 0))).toBe(false);
    expect(cronMatches("0 9-17 * * *", at(2026, 7, 8, 18, 0))).toBe(false);
  });

  it("matches step values, only on the stepped minutes", () => {
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 0))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 15))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 30))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 45))).toBe(true);
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 1))).toBe(false);
    expect(cronMatches("*/15 * * * *", at(2026, 7, 8, 0, 20))).toBe(false);
  });

  it("matches a stepped range", () => {
    // Matches 9, 11, 13, 15, 17
    expect(cronMatches("0 9-17/2 * * *", at(2026, 7, 8, 9, 0))).toBe(true);
    expect(cronMatches("0 9-17/2 * * *", at(2026, 7, 8, 11, 0))).toBe(true);
    expect(cronMatches("0 9-17/2 * * *", at(2026, 7, 8, 10, 0))).toBe(false);
  });

  it("matches comma-separated lists", () => {
    expect(cronMatches("0,15,45 * * * *", at(2026, 7, 8, 0, 0))).toBe(true);
    expect(cronMatches("0,15,45 * * * *", at(2026, 7, 8, 0, 15))).toBe(true);
    expect(cronMatches("0,15,45 * * * *", at(2026, 7, 8, 0, 45))).toBe(true);
    expect(cronMatches("0,15,45 * * * *", at(2026, 7, 8, 0, 30))).toBe(false);
  });

  it("matches day-of-week, treating Sunday as both 0 and 7", () => {
    // 2026-07-06 is a Monday
    expect(cronMatches("0 9 * * 1", at(2026, 7, 6, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 1", at(2026, 7, 7, 9, 0))).toBe(false);

    // 2026-07-05 is a Sunday
    expect(cronMatches("0 9 * * 0", at(2026, 7, 5, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 7", at(2026, 7, 5, 9, 0))).toBe(true);
  });

  it("applies OR semantics when both day-of-month and day-of-week are restricted", () => {
    // 2026-07-08 is a Wednesday (dow=3). DOM=8 matches; DOW=1 (Monday) does not.
    // Since both fields are restricted, OR semantics mean this should match on DOM alone.
    expect(cronMatches("0 9 8 * 1", at(2026, 7, 8, 9, 0))).toBe(true);
    // Neither DOM (15) nor DOW (1, Monday) match 2026-07-08 (Wednesday, 8th).
    expect(cronMatches("0 9 15 * 1", at(2026, 7, 8, 9, 0))).toBe(false);
  });

  it("requires both day-of-month and day-of-week to match when one is a wildcard", () => {
    // DOW wildcard -> only DOM must match.
    expect(cronMatches("0 9 8 * *", at(2026, 7, 8, 9, 0))).toBe(true);
    expect(cronMatches("0 9 9 * *", at(2026, 7, 8, 9, 0))).toBe(false);

    // DOM wildcard -> only DOW must match. 2026-07-08 is a Wednesday (dow=3).
    expect(cronMatches("0 9 * * 3", at(2026, 7, 8, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 1", at(2026, 7, 8, 9, 0))).toBe(false);
  });

  it("matches month restrictions", () => {
    expect(cronMatches("0 0 1 7 *", at(2026, 7, 1, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1 8 *", at(2026, 7, 1, 0, 0))).toBe(false);
  });

  it("returns false for a malformed expression instead of throwing", () => {
    expect(cronMatches("not a cron", at(2026, 7, 8, 0, 0))).toBe(false);
  });
});

describe("isValidCron", () => {
  it("accepts standard wildcard and combined expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("0 * * * *")).toBe(true);
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 9-17/2 * * 1-5")).toBe(true);
    expect(isValidCron("0,15,45 9 1,15 * *")).toBe(true);
  });

  it("rejects expressions with the wrong number of fields", () => {
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("* * * * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("* 24 * * *")).toBe(false);
    expect(isValidCron("* * 32 * *")).toBe(false);
    expect(isValidCron("* * * 13 *")).toBe(false);
    expect(isValidCron("* * * * 8")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidCron("a b c d e")).toBe(false);
    expect(isValidCron("* * * * abc")).toBe(false);
    expect(isValidCron("5-2 * * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
  });
});
