// CLI configuration - handles app data without Electron dependencies
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

export interface Repository {
  path: string;
  name: string;
  addedAt: string;
}

export interface ProjectEntry {
  path: string;
  name: string;
  addedAt: string;
}

export interface PoolConfig {
  name: string;
  prefix: string;
  type: 'recyclable' | 'ephemeral';
  maintenanceCommand?: string;
  taskCommand?: string;
  backgroundTaskCommand?: string;
  claudeCommand?: string;
}

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

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
  terminalLogDir?: string | null;
  pools?: PoolConfig[];
  defaultTaskPool?: string | null;
  automations?: AutomationDefinition[];
  showAutomationsTab?: boolean;
  showTrackedTab?: boolean;
}

export interface SessionMeta {
  type: "chat" | "claude-code";
  closed?: boolean;
}

export interface GlobalSettings {
  defaultEditor: string | null;
  defaultTerminal: string | null;
  defaultClaudeCommand: string | null;
  markdownSerif?: boolean;
  // Max lines of scrollback saved for a non-Claude terminal when it dies, shown
  // read-only on next open. Defaults to 500.
  terminalScrollbackLines?: number;
}

export interface AppData {
  repositories: Repository[];
  projects: ProjectEntry[];
  repositoryConfigs: Record<string, RepositoryConfig>;
  selectedRepo: string | null;
  recentWorktrees: Record<string, string>;
  starredWorktrees: Record<string, string[]>;
  pinnedFolders: string[];
  pinnedSessions: string[];
  // worktree paths where many has launched a terminal (used to scope recent Claude sessions to ones started in-app)
  terminalWorktrees: string[];
  worktreeOrder: Record<string, string[]>;
  windowBounds: { width: number; height: number; x?: number; y?: number };
  worktreeTerminals: Record<string, unknown>;
  sessionMeta: Record<string, SessionMeta>;
  globalSettings: GlobalSettings;
}

const defaultAppData: AppData = {
  repositories: [],
  projects: [],
  repositoryConfigs: {},
  selectedRepo: null,
  recentWorktrees: {},
  starredWorktrees: {},
  pinnedFolders: [],
  pinnedSessions: [],
  terminalWorktrees: [],
  worktreeOrder: {},
  windowBounds: { width: 1200, height: 800 },
  worktreeTerminals: {},
  sessionMeta: {},
  globalSettings: { defaultEditor: null, defaultTerminal: null, defaultClaudeCommand: null },
};

// Get platform-specific data directory
export function getDataPath(): string {
  const platform = process.platform;
  const homeDir = os.homedir();

  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "many");
  } else if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "many");
  } else {
    // Linux and others
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "many");
  }
}

export function getDataFilePath(): string {
  return path.join(getDataPath(), "app-data.json");
}

export async function loadAppData(): Promise<AppData> {
  const dataPath = getDataFilePath();
  try {
    const data = await fs.readFile(dataPath, "utf-8");
    return { ...defaultAppData, ...JSON.parse(data) };
  } catch (error: unknown) {
    // Only return defaults if the file doesn't exist yet (first run)
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      return defaultAppData;
    }
    // For any other error (parse error, permission error, etc.), throw so we
    // don't silently lose data by later saving empty defaults over real config
    throw new Error(`Failed to load config from ${dataPath}: ${error instanceof Error ? error.message : error}`);
  }
}

export async function saveAppData(data: AppData): Promise<void> {
  const dataPath = getDataFilePath();
  const dir = path.dirname(dataPath);
  await fs.mkdir(dir, { recursive: true });
  // Write to a unique temp file, then rename for atomic write
  const tmpPath = dataPath + `.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, dataPath);
}

// In-process mutex for serializing read-modify-write cycles on app data.
// Prevents concurrent RPC handlers from clobbering each other's changes.
let appDataLock: Promise<void> = Promise.resolve();

/**
 * Atomically load app data, apply a mutation, and save it back.
 * Concurrent calls are serialized so no updates are lost.
 */
export async function withAppData<T>(mutator: (data: AppData) => T | Promise<T>): Promise<T> {
  // Chain onto the existing lock so callers serialize in order
  const prev = appDataLock;
  let resolve: () => void;
  appDataLock = new Promise<void>((r) => { resolve = r; });
  try {
    await prev;
    const data = await loadAppData();
    const result = await mutator(data);
    await saveAppData(data);
    return result;
  } finally {
    resolve!();
  }
}

export function getGlobalSettings(appData: AppData): GlobalSettings {
  return appData.globalSettings || { defaultEditor: null, defaultTerminal: null, defaultClaudeCommand: null, terminalScrollbackLines: 500 };
}

export function getRepoConfig(appData: AppData, repoPath: string): RepositoryConfig {
  return appData.repositoryConfigs[repoPath] || {
    mainBranch: null,
    initCommand: null,
    worktreeDirectory: null,
  };
}
