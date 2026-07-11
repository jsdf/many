import { promises as fs } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { parse as parseYaml, parseDocument, isSeq, isMap } from "yaml";
import type { ProjectEnv, ProjectLink, ProjectMetadata, ProjectPr, ProjectTask } from "../shared/protocol.js";

const _exec = promisify(exec);
const userShell = process.env.SHELL || "/bin/bash";

// Runs through a login shell so `gh` is found on PATH even when the server is
// launched from a GUI (Electron) with a minimal environment.
function execAsync(command: string) {
  return _exec(`${userShell} -l -c ${JSON.stringify(command)}`);
}

// A real GitHub PR URL: github.com/<owner>/<repo>/pull/<number>. Excludes
// `pull/new/...` create links and non-GitHub hosts, which `gh` can't view.
const GITHUB_PR_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i;

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

export function parseEnvsYml(content: string): ProjectEnv[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const list = isObject(parsed) ? parsed.envs : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((item) => ({
    kind: coerceStr(item.kind) ?? "",
    repo: coerceStr(item.repo),
    path: coerceStr(item.path),
    branch: coerceStr(item.branch),
    url: coerceStr(item.url),
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

// Maps a GitHub PR's live state to the prs.yml `status` vocabulary
// (draft/open/merged/closed).
export function ghStateToStatus(state: string, isDraft: boolean): string {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return isDraft ? "draft" : "open";
}

export type PrStatusFetcher = (url: string) => Promise<{ state: string; isDraft: boolean }>;

// Fetches a single PR's live state via the `gh` CLI.
const ghFetchPrStatus: PrStatusFetcher = async (url) => {
  const { stdout } = await execAsync(`gh pr view ${JSON.stringify(url)} --json state,isDraft`);
  const parsed = JSON.parse(stdout) as { state?: unknown; isDraft?: unknown };
  return { state: String(parsed.state ?? ""), isDraft: parsed.isDraft === true };
};

// Refetches the live state of every GitHub PR listed in a project's prs.yml and
// writes the updated `status` back into the file, preserving comments, notes,
// and formatting via the YAML document API. PRs whose URL isn't a viewable
// GitHub PR are skipped; per-PR fetch failures are collected and reported
// rather than aborting the whole refresh. Returns the re-read metadata.
export async function refreshPrsYml(
  projectPath: string,
  fetchStatus: PrStatusFetcher = ghFetchPrStatus
): Promise<{ metadata: ProjectMetadata; refreshed: number; errors: string[] }> {
  const filePath = path.join(projectPath, "prs.yml");
  const content = await readIfExists(filePath);
  if (content === null) throw new Error(`No prs.yml found in ${projectPath}`);

  const doc = parseDocument(content);
  const seq = doc.get("prs");
  const errors: string[] = [];
  let refreshed = 0;

  if (isSeq(seq)) {
    await Promise.all(
      seq.items.map(async (item) => {
        if (!isMap(item)) return;
        const url = coerceStr(item.get("url"));
        if (!url || !GITHUB_PR_RE.test(url)) return;
        try {
          const { state, isDraft } = await fetchStatus(url);
          item.set("status", ghStateToStatus(state, isDraft));
          refreshed++;
        } catch (err) {
          errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
    );
  }

  if (refreshed > 0) await fs.writeFile(filePath, doc.toString(), "utf-8");

  const metadata = await readProjectMetadata(projectPath);
  return { metadata, refreshed, errors };
}

// Well-known project doc files surfaced as open-file shortcuts in the Overview.
const DOC_FILES = ["PROJECT.md", "HISTORY.md", "LEARNINGS.md", "PRIORITIES.md", "TODO.md"];

// Returns true if a file exists at the given path.
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Reads env-jsdf-style sidecar files from a project directory. Missing files
// are reported via the `has*` flags rather than treated as errors.
export async function readProjectMetadata(projectPath: string): Promise<ProjectMetadata> {
  const [projectMd, prsYml, tasksYml, envsYml, docPresence] = await Promise.all([
    readIfExists(path.join(projectPath, "PROJECT.md")),
    readIfExists(path.join(projectPath, "prs.yml")),
    readIfExists(path.join(projectPath, "tasks.yml")),
    readIfExists(path.join(projectPath, "envs.yml")),
    Promise.all(DOC_FILES.map((name) => fileExists(path.join(projectPath, name)))),
  ]);

  const md = projectMd !== null ? parseProjectMd(projectMd) : { title: null, links: [] };

  return {
    title: md.title,
    links: md.links,
    prs: prsYml !== null ? parsePrsYml(prsYml) : [],
    tasks: tasksYml !== null ? parseTasksYml(tasksYml) : [],
    envs: envsYml !== null ? parseEnvsYml(envsYml) : [],
    hasProjectMd: projectMd !== null,
    hasPrs: prsYml !== null,
    hasTasks: tasksYml !== null,
    hasEnvs: envsYml !== null,
    docs: DOC_FILES.filter((_, i) => docPresence[i]),
  };
}
