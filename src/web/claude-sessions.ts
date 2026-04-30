import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";

export interface ClaudeSession {
  sessionId: string;
  firstPrompt: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  isRunning: boolean;
  projectPath: string;
  sessionType?: "chat" | "claude-code";
  closed?: boolean;
}

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary?: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

const RUNNING_THRESHOLD_MS = 30_000;
const MAX_SESSIONS = 20;

function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function encodeProjectPath(dirPath: string): string {
  return dirPath.replace(/\//g, "-");
}

/**
 * Read sessions from sessions-index.json (fast path).
 * Returns null if the index doesn't exist.
 */
async function readSessionsIndex(
  projectDir: string
): Promise<SessionsIndexEntry[] | null> {
  const indexPath = path.join(projectDir, "sessions-index.json");
  try {
    const data = await fs.promises.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed.entries;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract session metadata from the first few lines of a JSONL file.
 */
async function scanSessionFile(
  filePath: string
): Promise<{
  sessionId: string;
  cwd: string;
  gitBranch: string;
  firstPrompt: string;
  messageCount: number;
} | null> {
  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let gitBranch = "";
    let firstPrompt = "";
    let messageCount = 0;
    let linesRead = 0;

    for await (const line of rl) {
      if (linesRead++ > 200) break; // don't scan entire huge files
      if (!line.trim()) continue;

      try {
        const record = JSON.parse(line);

        if (!sessionId && record.sessionId) {
          sessionId = record.sessionId;
        }
        if (!cwd && record.cwd) {
          cwd = record.cwd;
        }
        if (!gitBranch && record.gitBranch) {
          gitBranch = record.gitBranch;
        }

        if (record.type === "user" || record.type === "assistant") {
          messageCount++;
        }

        if (
          !firstPrompt &&
          record.type === "user" &&
          record.message?.content
        ) {
          const content = record.message.content;
          if (typeof content === "string") {
            firstPrompt = content.slice(0, 200);
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                firstPrompt = block.text.slice(0, 200);
                break;
              }
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    stream.destroy();

    if (!sessionId) return null;

    return {
      sessionId,
      cwd: cwd || "",
      gitBranch,
      firstPrompt,
      messageCount,
    };
  } catch {
    return null;
  }
}

/**
 * Get Claude Code sessions for a given worktree path.
 */
export async function getClaudeSessions(
  worktreePath: string
): Promise<ClaudeSession[]> {
  const projectsDir = getClaudeProjectsDir();
  const encodedPath = encodeProjectPath(worktreePath);
  const projectDir = path.join(projectsDir, encodedPath);

  try {
    await fs.promises.access(projectDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const sessions: ClaudeSession[] = [];
  const coveredSessionIds = new Set<string>();

  // Fast path: use sessions-index.json for entries that still have files
  const indexEntries = await readSessionsIndex(projectDir);
  if (indexEntries) {
    for (const entry of indexEntries) {
      if (entry.isSidechain) continue;

      let mtime: number;
      try {
        const stat = await fs.promises.stat(entry.fullPath);
        mtime = stat.mtimeMs;
      } catch {
        continue; // file gone
      }

      coveredSessionIds.add(entry.sessionId);
      sessions.push({
        sessionId: entry.sessionId,
        firstPrompt: entry.firstPrompt || "",
        summary: entry.summary,
        messageCount: entry.messageCount || 0,
        created: entry.created,
        modified: entry.modified,
        gitBranch: entry.gitBranch || "",
        isRunning: now - mtime < RUNNING_THRESHOLD_MS,
        projectPath: entry.projectPath || worktreePath,
      });
    }
  }

  // Scan .jsonl files not covered by the index
  const files = await fs.promises.readdir(projectDir);
  const jsonlFiles = files.filter(
    (f) => f.endsWith(".jsonl") && !f.startsWith("agent-")
  );

  for (const file of jsonlFiles) {
    const sessionId = file.replace(".jsonl", "");
    if (coveredSessionIds.has(sessionId)) continue;

    const filePath = path.join(projectDir, file);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }

    const scanned = await scanSessionFile(filePath);
    if (!scanned) continue;

    sessions.push({
      sessionId: scanned.sessionId,
      firstPrompt: scanned.firstPrompt,
      messageCount: scanned.messageCount,
      created: new Date(stat.birthtimeMs).toISOString(),
      modified: new Date(stat.mtimeMs).toISOString(),
      gitBranch: scanned.gitBranch,
      isRunning: now - stat.mtimeMs < RUNNING_THRESHOLD_MS,
      projectPath: scanned.cwd || worktreePath,
    });
  }

  sessions.sort(
    (a, b) =>
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
  );
  return sessions.slice(0, MAX_SESSIONS);
}

export interface SessionMessage {
  ordinal: number;
  role: string;
  text: string;
  timestamp: number | null;
  toolUses: { name: string; input: string }[];
}

/**
 * Strip XML-like tags that are injected by the system (system-reminder, etc.)
 */
function stripSystemTags(text: string): string {
  return text.replace(/<(?:system-reminder|task-notification|local-command-[^>]*|available-deferred-tools)[^>]*>[\s\S]*?<\/(?:system-reminder|task-notification|local-command-[^>]*|available-deferred-tools)>/g, "").trim();
}

/**
 * Extract text content from a message content field (string or array of content blocks).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "tool_result" && Array.isArray(block.content)) {
      for (const sub of block.content) {
        if (sub?.type === "text" && typeof sub.text === "string") {
          parts.push(sub.text);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extract tool uses from an assistant message content array.
 */
function extractToolUses(content: unknown): { name: string; input: string }[] {
  if (!Array.isArray(content)) return [];
  const tools: { name: string; input: string }[] = [];
  for (const block of content) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      tools.push({
        name: block.name,
        input: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
      });
    }
  }
  return tools;
}

/**
 * Read all messages from a Claude session JSONL file.
 */
export async function getSessionMessages(
  sessionId: string,
  worktreePath: string,
  offset = 0,
  limit = 200,
): Promise<{ messages: SessionMessage[]; total: number }> {
  const projectsDir = getClaudeProjectsDir();
  const encodedPath = encodeProjectPath(worktreePath);
  const projectDir = path.join(projectsDir, encodedPath);
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);

  try {
    await fs.promises.access(filePath);
  } catch {
    return { messages: [], total: 0 };
  }

  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const messages: SessionMessage[] = [];
  let ordinal = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type !== "user" && record.type !== "assistant") continue;

      const content = record.message?.content;
      const text = stripSystemTags(extractText(content));
      const toolUses = record.type === "assistant" ? extractToolUses(content) : [];

      // Skip empty tool-result user messages (they just acknowledge tool output)
      if (record.type === "user" && !text && toolUses.length === 0) {
        continue;
      }

      const ts = record.timestamp ? new Date(record.timestamp).getTime() : null;

      messages.push({
        ordinal,
        role: record.type,
        text,
        timestamp: ts,
        toolUses,
      });
      ordinal++;
    } catch {
      // skip malformed lines
    }
  }

  stream.destroy();

  const total = messages.length;
  const sliced = messages.slice(offset, offset + limit);
  return { messages: sliced, total };
}
