import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses a frontmatter block into properties and body", () => {
    const result = parseFrontmatter("---\ntitle: Hello\ncount: 3\ndone: true\n---\n\n# Body\n");
    expect(result.hasFrontmatter).toBe(true);
    expect(result.properties).toEqual({ title: "Hello", count: 3, done: true });
    expect(result.body).toBe("\n# Body\n");
  });

  it("parses list values", () => {
    const result = parseFrontmatter("---\ntags:\n  - a\n  - b\n---\nbody");
    expect(result.properties).toEqual({ tags: ["a", "b"] });
  });

  it("treats content without frontmatter as body", () => {
    const result = parseFrontmatter("# Just a heading\n");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.properties).toEqual({});
    expect(result.body).toBe("# Just a heading\n");
  });

  it("does not treat a horizontal rule as frontmatter", () => {
    const result = parseFrontmatter("text\n\n---\n\nmore");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe("text\n\n---\n\nmore");
  });

  it("leaves malformed YAML untouched in the body", () => {
    const content = "---\n: : :\n---\nbody";
    const result = parseFrontmatter(content);
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe(content);
  });

  it("treats a non-mapping frontmatter as body", () => {
    const content = "---\n- just\n- a\n- list\n---\nbody";
    const result = parseFrontmatter(content);
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toBe(content);
  });

  it("handles empty frontmatter", () => {
    const result = parseFrontmatter("---\n---\nbody");
    expect(result.hasFrontmatter).toBe(true);
    expect(result.properties).toEqual({});
    expect(result.body).toBe("body");
  });
});

describe("serializeFrontmatter", () => {
  it("drops the frontmatter block when there are no properties", () => {
    expect(serializeFrontmatter({}, "# Body")).toBe("# Body");
  });

  it("emits a frontmatter block before the body", () => {
    const out = serializeFrontmatter({ title: "Hi", tags: ["a", "b"] }, "\n# Body\n");
    expect(out).toBe("---\ntitle: Hi\ntags:\n  - a\n  - b\n---\n\n# Body\n");
  });

  it("round-trips parse -> serialize", () => {
    const original = "---\ntitle: Hello\ncount: 3\ntags:\n  - x\n  - y\n---\n\n# Body\n";
    const parsed = parseFrontmatter(original);
    expect(serializeFrontmatter(parsed.properties, parsed.body)).toBe(original);
  });
});
