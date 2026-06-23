import { promises as fs } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import type { ProjectLink, ProjectMetadata, ProjectPr, ProjectTask } from "../shared/protocol.js";

// Leading YAML frontmatter block: `---` line, content, closing `---` line.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?/;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// A scalar frontmatter/yaml value rendered as text. Numbers and booleans become
// strings; empty strings and everything else (null, arrays, objects) drop out.
function coerceStr(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

const URL_RE = /^https?:\/\//i;

// PROJECT.md frontmatter -> link buttons. Every non-empty scalar property
// becomes a link; `isUrl` marks the ones that can be opened externally
// (notion, linear). Empty values (e.g. `notion: ""`) are skipped.
export function parseProjectMd(content: string): { title: string | null; links: ProjectLink[] } {
  const match = content.match(FRONTMATTER_RE);
  const links: ProjectLink[] = [];
  let body = content;

  if (match) {
    body = content.slice(match[0].length);
    const yamlText = match[1] ?? "";
    let parsed: unknown;
    try {
      parsed = yamlText.trim() === "" ? {} : parseYaml(yamlText);
    } catch {
      parsed = {};
    }
    if (isObject(parsed)) {
      for (const [key, raw] of Object.entries(parsed)) {
        const value = coerceStr(raw);
        if (value === undefined) continue;
        links.push({ key, value, isUrl: URL_RE.test(value) });
      }
    }
  }

  const heading = body.match(/^#\s+(.+?)\s*$/m);
  const title = heading ? heading[1].trim() : null;
  return { title, links };
}

export function parsePrsYml(content: string): ProjectPr[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const list = isObject(parsed) ? parsed.prs : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((item) => ({
    url: coerceStr(item.url) ?? "",
    title: coerceStr(item.title),
    branch: coerceStr(item.branch),
    status: coerceStr(item.status),
    notes: coerceStr(item.notes),
  }));
}

export function parseTasksYml(content: string): ProjectTask[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const list = isObject(parsed) ? parsed.tasks : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((item) => ({
    url: coerceStr(item.url) ?? "",
    title: coerceStr(item.title),
    status: coerceStr(item.status),
    focused: item.focused === true,
    notes: coerceStr(item.notes),
  }));
}

// Returns the file's text, or null if it doesn't exist. Other read errors
// (permissions, etc.) propagate so they aren't silently hidden.
async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Reads env-jsdf-style sidecar files from a project directory. Missing files
// are reported via the `has*` flags rather than treated as errors.
export async function readProjectMetadata(projectPath: string): Promise<ProjectMetadata> {
  const [projectMd, prsYml, tasksYml] = await Promise.all([
    readIfExists(path.join(projectPath, "PROJECT.md")),
    readIfExists(path.join(projectPath, "prs.yml")),
    readIfExists(path.join(projectPath, "tasks.yml")),
  ]);

  const md = projectMd !== null ? parseProjectMd(projectMd) : { title: null, links: [] };

  return {
    title: md.title,
    links: md.links,
    prs: prsYml !== null ? parsePrsYml(prsYml) : [],
    tasks: tasksYml !== null ? parseTasksYml(tasksYml) : [],
    hasProjectMd: projectMd !== null,
    hasPrs: prsYml !== null,
    hasTasks: tasksYml !== null,
  };
}
