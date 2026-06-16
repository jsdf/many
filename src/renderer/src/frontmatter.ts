import { parse, stringify } from "yaml";

export type PropertyValue = string | number | boolean | Array<string | number> | null;

export interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  properties: Record<string, PropertyValue>;
  body: string;
}

// Matches a leading YAML frontmatter block: `---` on the first line, content,
// then a closing `---` line. Captures the YAML between the fences.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?/;

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { hasFrontmatter: false, properties: {}, body: content };
  }

  const yamlText = match[1] ?? "";
  const body = content.slice(match[0].length);

  let parsed: unknown;
  try {
    parsed = yamlText.trim() === "" ? {} : parse(yamlText);
  } catch {
    // Malformed YAML: leave the file untouched rather than corrupting it.
    return { hasFrontmatter: false, properties: {}, body: content };
  }

  // Only a YAML mapping is valid frontmatter; anything else stays in the body.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { hasFrontmatter: false, properties: {}, body: content };
  }

  return { hasFrontmatter: true, properties: parsed as Record<string, PropertyValue>, body };
}

export function serializeFrontmatter(properties: Record<string, PropertyValue>, body: string): string {
  if (Object.keys(properties).length === 0) {
    return body;
  }
  return `---\n${stringify(properties)}---\n${body}`;
}
