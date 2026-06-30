import { describe, it, expect } from "vitest";
import { parsePs, sumSubtreeMemory } from "./process-stats.js";

describe("parsePs", () => {
  it("parses well-formed lines", () => {
    const output = "  1   0  1024\n  2   1  2048\n  3   1   512\n";
    const entries = parsePs(output);
    expect(entries).toEqual([
      { pid: 1, ppid: 0, rssKb: 1024 },
      { pid: 2, ppid: 1, rssKb: 2048 },
      { pid: 3, ppid: 1, rssKb: 512 },
    ]);
  });

  it("skips blank lines", () => {
    const output = "\n  1   0  100\n\n  2   1  200\n";
    const entries = parsePs(output);
    expect(entries).toHaveLength(2);
  });

  it("skips malformed lines (too few columns)", () => {
    const output = "  1   0\n  2   1  200\n";
    const entries = parsePs(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(2);
  });

  it("skips lines with non-numeric values", () => {
    const output = "  PID  PPID   RSS\n  1   0  100\n";
    const entries = parsePs(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(1);
  });
});

describe("sumSubtreeMemory", () => {
  const entries = [
    { pid: 1, ppid: 0, rssKb: 100 },
    { pid: 2, ppid: 1, rssKb: 200 },
    { pid: 3, ppid: 1, rssKb: 300 },
    { pid: 4, ppid: 2, rssKb: 400 },
  ];

  it("sums RSS of root, children, and grandchildren", () => {
    const result = sumSubtreeMemory(entries, [1]);
    const stats = result.get(1);
    expect(stats).toBeDefined();
    // 100 + 200 + 300 + 400 = 1000 KB = 1024000 bytes
    expect(stats!.memoryBytes).toBe(1000 * 1024);
    expect(stats!.processCount).toBe(4);
  });

  it("returns only own RSS for a root with no descendants", () => {
    const result = sumSubtreeMemory(entries, [4]);
    const stats = result.get(4);
    expect(stats!.memoryBytes).toBe(400 * 1024);
    expect(stats!.processCount).toBe(1);
  });

  it("returns memoryBytes 0 and processCount 0 for a pid not present in entries", () => {
    const result = sumSubtreeMemory(entries, [999]);
    const stats = result.get(999);
    expect(stats!.memoryBytes).toBe(0);
    expect(stats!.processCount).toBe(0);
  });

  it("computes multiple roots independently in one call", () => {
    const result = sumSubtreeMemory(entries, [2, 3]);
    const stats2 = result.get(2);
    const stats3 = result.get(3);
    // pid 2 subtree: 200 + 400 = 600 KB
    expect(stats2!.memoryBytes).toBe(600 * 1024);
    expect(stats2!.processCount).toBe(2);
    // pid 3 subtree: 300 KB, no children
    expect(stats3!.memoryBytes).toBe(300 * 1024);
    expect(stats3!.processCount).toBe(1);
  });
});
