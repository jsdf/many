/**
 * Unified RPC protocol for many.
 * Mux-style: typed queries and subscriptions over a single WebSocket.
 *
 * All server ↔ renderer communication goes through this protocol.
 * Domain grouping by prefix: worktree.*, repo.*, branch.*, terminal.*,
 * stream.*, session.*, task.*, settings.*, action.*
 */

// ---------------------------------------------------------------------------
// Domain types (shared between server and renderer)
// ---------------------------------------------------------------------------

export interface Repository {
  path: string;
  name?: string;
  addedAt?: string;
}

export interface ProjectEntry {
  path: string;
  name: string;
  addedAt: string;
}

// A single PROJECT.md frontmatter entry surfaced as a button (e.g. notion,
// linear). `isUrl` is true when the value is an http(s) URL and can be opened.
export interface ProjectLink {
  key: string;
  value: string;
  isUrl: boolean;
}

// One dated entry from a PR's `history` list in prs.yml.
export interface ProjectPrHistoryEntry {
  at?: string;
  note: string;
}

// One entry from a project's prs.yml.
export interface ProjectPr {
  url: string;
  title?: string;
  branch?: string;
  base?: string;
  status?: string;
  description?: string;
  history: ProjectPrHistoryEntry[];
}

// One entry from a project's tasks.yml.
export interface ProjectTask {
  url: string;
  title?: string;
  status?: string;
  focused?: boolean;
  notes?: string;
}

// One entry from a project's envs.yml. `kind` is worktree|ona|devin|cursor;
// worktrees carry `repo`/`path`, cloud sessions carry `url`.
export interface ProjectEnv {
  kind: string;
  repo?: string;
  path?: string;
  branch?: string;
  url?: string;
  notes?: string;
}

// Parsed env-jsdf-style project sidecar files for a project directory.
// Each `has*` flag distinguishes "file absent" from "file present but empty".
export interface ProjectMetadata {
  title: string | null;
  links: ProjectLink[];
  prs: ProjectPr[];
  tasks: ProjectTask[];
  envs: ProjectEnv[];
  hasProjectMd: boolean;
  hasPrs: boolean;
  hasTasks: boolean;
  hasEnvs: boolean;
  // Names of the well-known project doc files present in the directory
  // (PROJECT.md, HISTORY.md, LEARNINGS.md, PRIORITIES.md, TODO.md), in that
  // order. Surfaced as open-file shortcuts in the Overview.
  docs: string[];
}

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface Worktree {
  path: string;
  branch: string | null;
  commit: string;
  bare: boolean;
  isAvailable: boolean;
  worktreeName: string;
}

export interface PoolConfig {
  name: string;
  prefix: string;
  type: "recyclable" | "ephemeral";
  maintenanceCommand?: string;
  taskCommand?: string;
  backgroundTaskCommand?: string;
  claudeCommand?: string;
}

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
  terminalLogDir?: string | null;
  pools?: PoolConfig[];
  defaultTaskPool?: string | null;
  showTrackedTab?: boolean;
  showAutomationsTab?: boolean;
}

export interface MergeOptions {
  squash: boolean;
  noFF: boolean;
  message: string;
  deleteWorktree: boolean;
  worktreePath?: string;
}

export interface GitStatus {
  modified: string[];
  not_added: string[];
  deleted: string[];
  created: string[];
  staged: string[];
  hasChanges: boolean;
  hasStaged: boolean;
  truncated?: boolean;
  totalFiles?: number;
}

export interface BranchStackEntry {
  branch: string;
  isCurrent: boolean;
  isTrunk: boolean;
}

export interface BranchStackResult {
  stack: BranchStackEntry[];
  source: "graphite" | "git";
  trunk: string;
}

export interface GlobalSettings {
  defaultEditor?: string | null;
  defaultTerminal?: string | null;
  defaultClaudeCommand?: string | null;
  markdownSerif?: boolean;
  terminalScrollbackLines?: number;
}

export interface TaskRecord {
  id: string;
  pid: number;
  repoPath: string;
  worktreePath: string;
  poolPrefix: string;
  poolName: string;
  branch: string;
  prompt: string;
  taskCommand: string;
  logFile: string;
  status: "running" | "completed" | "failed" | "unknown";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  recursiveMemoryBytes?: number;
  processCount?: number;
  launchedBy: "cli" | "web";
  // Set for saved terminal snapshots that were running a Claude Code session, so
  // the restored read-only view can show the transcript instead of raw output.
  claudeSessionId?: string;
}

export interface GitHubLink {
  type: "pr" | "branch";
  url: string;
}

export interface LinearLink {
  linearId: string;
  linearUrl: string;
}

// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

export type AutomationRunTarget = 'worktree' | 'mainRepo';

export interface AutomationSchedule {
  cron: string;
  enabled: boolean;
}

export interface AutomationDefinition {
  id: string;
  name: string;
  type: 'custom' | 'skill' | 'shell';
  prompt?: string;
  skillName?: string;
  script?: string;
  runTarget?: AutomationRunTarget;
  schedule?: AutomationSchedule;
}

export type WorkItemStatus = "pending" | "running" | "completed" | "failed";
export type AutomationRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkItem {
  id: string;
  prompt: string;
  status: WorkItemStatus;
  taskId?: string;
  worktreePath?: string;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  repoPath: string;
  status: AutomationRunStatus;
  startedAt: string;
  endedAt?: string;
  workItems: WorkItem[];
}

// Terminal events pushed via subscription
export type TerminalEvent =
  | { type: "data"; data: string }
  | { type: "buffered"; data: string }
  | { type: "bell" }
  | { type: "exit" };

// Streaming operation events (replaces SSE)
export type StreamEvent =
  | { type: "step"; text: string }
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; text: string }
  | {
      type: "done";
      success: boolean;
      worktreePath?: string;
      branch?: string;
      code?: number;
      taskId?: string;
    };

// ---------------------------------------------------------------------------
// Claude UI session types (CLI-backed sessions via libclaude)
// ---------------------------------------------------------------------------

export type ClaudeUiPermissionMode =
  | "auto"
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

// Model/effort passed as spawn-time `--model` / `--effort` flags. "default"
// means don't pass the flag (use the CLI's own default). Changing either at
// runtime respawns the CLI process resuming the same on-disk conversation.
export type ClaudeUiModel = "default" | "fable" | "opus" | "sonnet";

export type ClaudeUiEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeUiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError: boolean };

export type ClaudeUiEvent =
  | { type: "init"; sessionId: string }
  | { type: "status"; ready: boolean; busy: boolean; queued: number; sessionId: string | null }
  | { type: "title"; title: string }
  | { type: "prompt"; text: string; ts?: number }
  | { type: "assistant"; content: ClaudeUiContentBlock[]; ts?: number }
  | { type: "user"; content: ClaudeUiContentBlock[]; ts?: number }
  | { type: "result"; isError: boolean; costUsd?: number; durationMs?: number }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Query procedures (one-shot request → response)
// ---------------------------------------------------------------------------

export interface QueryProcedures {
  // --- Worktree operations ---
  "worktree.list": {
    input: { repoPath: string };
    output: Worktree[];
  };
  "worktree.status": {
    input: { worktreePath: string };
    output: GitStatus;
  };
  "worktree.commitLog": {
    input: { worktreePath: string; baseBranch?: string };
    output: string;
  };
  "worktree.branchDiff": {
    input: { worktreePath: string; repoPath: string };
    output: { diff: string; truncated?: boolean };
  };
  "worktree.archive": {
    input: { repoPath: string; worktreePath: string; force?: boolean };
    output: { ok: boolean };
  };
  "worktree.create": {
    input: { repoPath: string; branchName: string; baseBranch?: string };
    output: { path: string; branch: string };
  };
  "worktree.createPool": {
    input: { repoPath: string; worktreeName: string };
    output: { path: string; branch: string };
  };
  "worktree.claim": {
    input: { repoPath: string; worktreePath: string; branchName: string };
    output: { ok: boolean };
  };
  "worktree.release": {
    input: { repoPath: string; worktreePath: string; force?: boolean };
    output: { ok: boolean };
  };
  "worktree.stash": {
    input: { worktreePath: string; message?: string };
    output: { ok: boolean };
  };
  "worktree.clean": {
    input: { worktreePath: string };
    output: { ok: boolean };
  };
  "worktree.amend": {
    input: { worktreePath: string; noVerify?: boolean };
    output: { ok: boolean };
  };
  "worktree.commit": {
    input: { worktreePath: string; message: string; noVerify?: boolean };
    output: { ok: boolean };
  };
  "worktree.merge": {
    input: {
      repoPath: string;
      fromBranch: string;
      toBranch: string;
      options: MergeOptions;
    };
    output: { ok: boolean };
  };
  "worktree.rebase": {
    input: { worktreePath: string; fromBranch: string; ontoBranch: string };
    output: { ok: boolean };
  };
  "worktree.runMaintenance": {
    input: { worktreePath: string; command: string };
    output: { ok: boolean };
  };

  // --- Worktree starring & ordering ---
  "worktree.getStarred": {
    input: { repoPath: string };
    output: string[];
  };
  "worktree.setStarred": {
    input: { repoPath: string; worktreePath: string; starred: boolean };
    output: { ok: boolean };
  };
  "worktree.getOrder": {
    input: { repoPath: string };
    output: string[];
  };
  "worktree.setOrder": {
    input: { repoPath: string; order: string[] };
    output: { ok: boolean };
  };
  // --- Tracked branches ---
  "tracked.list": {
    input: { repoPath: string };
    output: string[];
  };
  "tracked.add": {
    input: { repoPath: string; input: string };
    output: { branch: string };
  };
  "tracked.remove": {
    input: { repoPath: string; branch: string };
    output: { ok: boolean };
  };
  "tracked.reorder": {
    input: { repoPath: string; branches: string[] };
    output: { ok: boolean };
  };

  // --- Branch operations ---
  "branch.list": {
    input: { repoPath: string };
    output: string[];
  };
  "branch.checkMerged": {
    input: { repoPath: string; branch: string; mainBranch?: string };
    output: { isFullyMerged: boolean; aheadCount: number; behindCount: number };
  };
  "branch.isTmp": {
    input: { branch: string };
    output: boolean;
  };
  "branch.defaultBranch": {
    input: { repoPath: string };
    output: string;
  };
  "branch.resolveStartingPoint": {
    input: { repoPath: string; startingPoint?: string; pullLatest?: boolean };
    output: { startingPoint: string };
  };
  "branch.stack": {
    input: { worktreePath: string; repoPath: string };
    output: BranchStackResult;
  };
  "branch.checkout": {
    input: { worktreePath: string; branch: string };
    output: { ok: boolean };
  };

  // --- Repository management ---
  "repo.list": {
    input: {};
    output: Repository[];
  };
  "repo.add": {
    input: { repoPath: string };
    output: { ok: boolean };
  };
  "projects.list": {
    input: {};
    output: ProjectEntry[];
  };
  "projects.add": {
    input: { projectPath: string };
    output: { ok: boolean };
  };
  "projects.remove": {
    input: { projectPath: string };
    output: { ok: boolean };
  };
  // Reads env-jsdf-style sidecar files (PROJECT.md frontmatter, prs.yml,
  // tasks.yml) from a project directory and returns the parsed metadata.
  "project.metadata": {
    input: { projectPath: string };
    output: ProjectMetadata;
  };
  // Refetches the live state of the GitHub PRs in the project's prs.yml via the
  // `gh` CLI, writes the updated statuses back to the file, and returns the
  // re-read metadata along with how many PRs were refreshed and any per-PR errors.
  "project.refreshPrs": {
    input: { projectPath: string };
    output: { metadata: ProjectMetadata; refreshed: number; errors: string[] };
  };
  "fs.listDir": {
    input: { dirPath: string };
    output: FsEntry[];
  };
  // Fuzzy-search a directory's files (same matcher and file source as
  // fs.allFiles) for paths matching the query. Returns, keyed by parent
  // directory, the matching files plus the ancestor directories needed to
  // render them as a tree.
  "fs.search": {
    input: { dirPath: string; query: string };
    output: Record<string, FsEntry[]>;
  };
  // List files under dirPath as paths relative to it, for client-side fuzzy
  // matching (quick open). In a git work tree this is the tracked +
  // untracked-not-ignored set (respects .gitignore); otherwise a directory walk
  // skipping .git/node_modules. Capped to keep the payload bounded on large trees.
  "fs.allFiles": {
    input: { dirPath: string };
    output: string[];
  };
  "fs.readFile": {
    input: { filePath: string };
    output: { content: string; size: number; tooLarge: boolean; binary: boolean };
  };
  "fs.writeFile": {
    input: { filePath: string; content: string };
    output: { ok: boolean };
  };
  // Create an empty file. Errors if the path already exists.
  "fs.createFile": {
    input: { filePath: string };
    output: { ok: boolean };
  };
  // Create a directory. Errors if the path already exists.
  "fs.createDir": {
    input: { dirPath: string };
    output: { ok: boolean };
  };
  // Rename/move a file or directory. Errors if the destination exists.
  "fs.rename": {
    input: { oldPath: string; newPath: string };
    output: { ok: boolean };
  };
  // Delete a file or directory (recursively).
  "fs.delete": {
    input: { path: string };
    output: { ok: boolean };
  };
  // Folders pinned to the Active list (global, absolute paths).
  "folder.getPinned": {
    input: {};
    output: string[];
  };
  "folder.setPinned": {
    input: { path: string; pinned: boolean };
    output: { ok: boolean };
  };
  // Persist the full pinned-folder order (drag-reorder in the Active tree).
  "folder.reorderPinned": {
    input: { order: string[] };
    output: { ok: boolean };
  };
  // Sessions (terminals/Claude sessions) pinned to the Active list. Keys are
  // "t:<terminalId>" or "c:<sessionId>" (global).
  "session.getPinned": {
    input: {};
    output: string[];
  };
  "session.setPinned": {
    input: { key: string; pinned: boolean };
    output: { ok: boolean };
  };
  "repo.getSelected": {
    input: {};
    output: string | null;
  };
  "repo.setSelected": {
    input: { repoPath: string | null };
    output: { ok: boolean };
  };
  "repo.getConfig": {
    input: { repoPath: string };
    output: RepositoryConfig;
  };
  // Whether the Tracked / Automations tabs should be shown, aggregated across
  // all repositories. These tabs live above the repo selector, so their
  // visibility must not depend on which repo is currently selected.
  "repo.tabVisibility": {
    input: {};
    output: { tracked: boolean; automations: boolean };
  };
  "repo.saveConfig": {
    input: { repoPath: string; config: RepositoryConfig };
    output: { ok: boolean };
  };
  "repo.recentWorktree": {
    input: { repoPath: string };
    output: string | null;
  };
  "repo.setRecentWorktree": {
    input: { repoPath: string; worktreePath: string };
    output: { ok: boolean };
  };
  "repo.gitUsername": {
    input: { repoPath: string };
    output: string;
  };
  "repo.githubLink": {
    input: { repoPath: string; branch: string };
    output: GitHubLink | null;
  };
  "repo.linearLink": {
    input: { repoPath: string; branch: string };
    output: LinearLink | null;
  };

  // --- Settings ---
  "settings.get": {
    input: {};
    output: GlobalSettings;
  };
  "settings.save": {
    input: GlobalSettings;
    output: { ok: boolean };
  };
  "settings.muxUrl": {
    input: { repoPath: string };
    output: { wsUrl: string | null; repo: string | null };
  };

  // --- External actions ---
  "action.openFileManager": {
    input: { path: string };
    output: { ok: boolean };
  };
  "action.openEditor": {
    input: { path: string; editor?: string | null };
    output: { ok: boolean };
  };
  "action.openTerminal": {
    input: { path: string; terminal?: string | null };
    output: { ok: boolean };
  };
  "action.openDirectory": {
    input: { path: string };
    output: { ok: boolean };
  };
  "action.openTerminalInDir": {
    input: { path: string; terminal?: string | null };
    output: { ok: boolean };
  };
  "action.openVSCode": {
    input: { path: string };
    output: { ok: boolean };
  };
  "action.openPath": {
    input: { path: string };
    output: { ok: boolean };
  };
  "action.selectFolder": {
    input: { initialPath?: string };
    output: { path: string | null };
  };

  // --- Task management ---
  "task.list": {
    input: { repoPath?: string };
    output: TaskRecord[];
  };
  "task.kill": {
    input: { taskId: string };
    output: { ok: boolean };
  };
  "task.remove": {
    input: { taskId: string };
    output: { ok: boolean };
  };
  "task.getLog": {
    input: { taskId: string; offset?: number };
    output: { content: string; size: number };
  };

  // --- Worktree activity (lightweight, in-memory) ---
  "worktree.activity": {
    input: {};
    output: Record<string, { terminals: number; claudeSessions: number }>;
  };

  // --- Terminal management ---
  "terminal.create": {
    input: {
      terminalId: string;
      worktreePath: string;
      cols: number;
      rows: number;
      isDark: boolean;
      env?: Record<string, string>;
      initialCommand?: string;
      taskId?: string;
      // Claude Code session id this terminal runs, when launched with a known id
      // (`claude --session-id <uuid>` or resumed via `--resume <id>`).
      claudeSessionId?: string;
    };
    output: { existed: boolean };
  };
  "terminal.input": {
    input: { terminalId: string; data: string };
    output: { ok: boolean };
  };
  "terminal.resize": {
    input: { terminalId: string; cols: number; rows: number };
    output: { ok: boolean };
  };
  "terminal.close": {
    input: { terminalId: string };
    output: { ok: boolean };
  };
  // Kill every live terminal whose worktreePath equals the given path.
  "terminal.closeWorktree": {
    input: { worktreePath: string };
    output: { closed: number };
  };
  "terminal.listSessions": {
    input: { worktreePath: string };
    output: Array<{ id: string; userLabel?: string; taskId?: string; createdAt?: number; lastDataAt?: number }>;
  };
  "terminal.setLabel": {
    input: { terminalId: string; label: string };
    output: { ok: boolean };
  };
  "terminal.listAll": {
    input: {};
    output: Array<{
      terminalId: string;
      worktreePath: string;
      createdAt: number;
      lastInputAt: number;
      lastDataAt: number;
      title?: string;
      userLabel?: string;
      claudeSessionId?: string;
      needsAttention: boolean;
    }>;
  };

  // --- Claude sessions ---
  "claude.sessions": {
    input: { worktreePath: string };
    output: unknown[]; // ClaudeSession[] from existing code (merged with sessionMeta)
  };
  "claude.sessionMessages": {
    input: {
      sessionId: string;
      worktreePath: string;
      offset?: number;
      limit?: number;
    };
    output: unknown; // existing session message format
  };
  // Most-recent Claude sessions whose cwd is within any of the given roots.
  "claude.recentSessions": {
    input: { rootPaths: string[]; limit?: number };
    output: Array<{
      sessionId: string;
      worktreePath: string;
      firstPrompt: string;
      summary?: string;
      modified: string;
      gitBranch: string;
      sessionType?: "chat" | "claude-code";
    }>;
  };
  "claude.setSessionMeta": {
    input: {
      sessionId: string;
      type?: "chat" | "claude-code";
      closed?: boolean;
    };
    output: { ok: boolean };
  };

  // --- Automation management ---
  "automation.list": {
    input: { repoPath: string };
    output: AutomationDefinition[];
  };
  "automation.save": {
    input: { repoPath: string; automation: AutomationDefinition };
    output: { ok: boolean };
  };
  "automation.delete": {
    input: { repoPath: string; automationId: string };
    output: { ok: boolean };
  };
  "automation.listRuns": {
    input: { repoPath?: string };
    output: AutomationRun[];
  };
  "automation.getRun": {
    input: { runId: string };
    output: AutomationRun | null;
  };
  "automation.cancelRun": {
    input: { runId: string };
    output: { ok: boolean };
  };

  // --- Claude UI (CLI-backed sessions) ---
  "claudeui.create": {
    input: { worktreePath: string };
    output: { sessionId: string };
  };
  "claudeui.resume": {
    input: { worktreePath: string; sessionId: string };
    output: { sessionId: string };
  };
  "claudeui.list": {
    input: { worktreePath: string };
    output: { sessionId: string; title?: string; needsAttention?: boolean }[];
  };
  "claudeui.listAll": {
    input: {};
    output: { sessionId: string; worktreePath: string; title?: string; needsAttention?: boolean }[];
  };
  "claudeui.setPermissionMode": {
    input: { sessionId: string; mode: ClaudeUiPermissionMode };
    output: { ok: boolean };
  };
  "claudeui.setModelEffort": {
    input: { sessionId: string; model: ClaudeUiModel; effort: ClaudeUiEffort };
    output: { ok: boolean };
  };
  "claudeui.send": {
    input: { sessionId: string; prompt: string };
    output: { ok: boolean };
  };
  "claudeui.interrupt": {
    input: { sessionId: string };
    output: { ok: boolean };
  };
  "claudeui.reset": {
    input: { sessionId: string };
    output: { ok: boolean };
  };
  "claudeui.close": {
    input: { sessionId: string };
    output: { ok: boolean };
  };
}

// ---------------------------------------------------------------------------
// Subscription procedures (long-lived push from server)
// ---------------------------------------------------------------------------

export interface SubscriptionProcedures {
  /** Live worktree list updates */
  "worktree.updates": {
    input: { repoPath: string };
    output: Worktree[];
  };
  /** Live git status for a worktree — updates whenever working files or the index change */
  "worktree.statusUpdates": {
    input: { worktreePath: string; repoPath: string };
    output: GitStatus;
  };
  /** Live branch diff for a worktree — updates whenever new commits land on the branch */
  "worktree.branchDiffUpdates": {
    input: { worktreePath: string; repoPath: string };
    output: { diff: string; truncated?: boolean };
  };
  /** Live per-worktree last-activity timestamps (ms): max of last Claude session and last git commit */
  "worktree.activityTimes": {
    input: { repoPath: string };
    output: Record<string, number>;
  };
  /** Live contents of a single directory, re-read whenever the directory changes on disk */
  "fs.dirUpdates": {
    input: { dirPath: string };
    output: FsEntry[];
  };
  /** Live contents of a single file, re-read whenever the file changes on disk */
  "fs.fileUpdates": {
    input: { filePath: string };
    output: { content: string; size: number; tooLarge: boolean; binary: boolean };
  };
  /** Terminal output/exit events */
  "terminal.events": {
    input: { terminalId: string };
    output: TerminalEvent;
  };
  /** Streaming init command output */
  "stream.runInit": {
    input: { worktreePath: string; initCommand: string };
    output: StreamEvent;
  };
  /** Streaming worktree creation progress */
  "stream.createWorktree": {
    input: {
      repoPath: string;
      worktreeName: string;
      startingPoint?: string;
      poolPrefix?: string;
      pullLatest?: boolean;
    };
    output: StreamEvent;
  };
  /** Streaming task launch progress */
  "stream.launchTask": {
    input: {
      repoPath: string;
      poolType: string;
      poolPrefix: string;
      prompt: string;
      startingPoint?: string;
      maintenanceCommand?: string;
      taskCommand?: string;
    };
    output: StreamEvent;
  };
  /** Claude UI session events (CLI-backed, streaming assistant/tool events) */
  "claudeui.events": {
    input: { sessionId: string };
    output: ClaudeUiEvent;
  };
  /** Live tail of a stored Claude session transcript: pushes newly appended messages as the .jsonl grows */
  "claude.sessionMessages.updates": {
    input: { sessionId: string; worktreePath: string; sinceOrdinal: number };
    output: { messages: unknown[]; fromOrdinal: number; total: number };
  };
  /** Run a single automation on a worktree */
  "stream.runAutomation": {
    input: {
      repoPath: string;
      automationId: string;
      worktreePath: string;
      prompt?: string;
    };
    output: StreamEvent;
  };
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { id: number; type: "query"; procedure: string; input: unknown }
  | { id: number; type: "subscribe"; procedure: string; input: unknown }
  | { id: number; type: "unsubscribe" };

export type ServerMessage =
  | { id: number; type: "result"; data: unknown }
  | { id: number; type: "data"; data: unknown }
  | { id: number; type: "error"; error: string };

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type QueryProcedure = keyof QueryProcedures;
export type SubscriptionProcedure = keyof SubscriptionProcedures;
export type Procedure = QueryProcedure | SubscriptionProcedure;

export type ProcedureInput<K extends Procedure> = K extends QueryProcedure
  ? QueryProcedures[K]["input"]
  : K extends SubscriptionProcedure
    ? SubscriptionProcedures[K]["input"]
    : never;

export type ProcedureOutput<K extends Procedure> = K extends QueryProcedure
  ? QueryProcedures[K]["output"]
  : K extends SubscriptionProcedure
    ? SubscriptionProcedures[K]["output"]
    : never;
