import { describe, it, expect } from "vitest";
import { wordStartBefore, lineStartBefore } from "./readline-edit";

describe("wordStartBefore", () => {
  it("deletes the word before the cursor", () => {
    expect(wordStartBefore("hello world", 11)).toBe(6);
  });

  it("skips trailing whitespace before the word", () => {
    expect(wordStartBefore("hello world   ", 14)).toBe(6);
  });

  it("returns 0 when the cursor is inside the first word", () => {
    expect(wordStartBefore("hello", 3)).toBe(0);
  });

  it("returns 0 at the start of the string", () => {
    expect(wordStartBefore("hello", 0)).toBe(0);
  });

  it("operates relative to the cursor, not the end", () => {
    expect(wordStartBefore("foo bar baz", 7)).toBe(4);
  });

  it("treats newlines as whitespace boundaries", () => {
    expect(wordStartBefore("foo\nbar", 7)).toBe(4);
  });
});

describe("lineStartBefore", () => {
  it("returns 0 for a single line", () => {
    expect(lineStartBefore("hello world", 11)).toBe(0);
  });

  it("returns the index after the previous newline", () => {
    expect(lineStartBefore("foo\nbar baz", 11)).toBe(4);
  });

  it("returns the cursor itself when already at line start", () => {
    expect(lineStartBefore("foo\nbar", 4)).toBe(4);
  });

  it("returns 0 at the start of the string", () => {
    expect(lineStartBefore("hello", 0)).toBe(0);
  });
});
