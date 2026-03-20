// CLI configuration - handles app data without Electron dependencies
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export interface Repository {
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
}

export interface RepositoryConfig {
  mainBranch: string | null;
  initCommand: string | null;
  worktreeDirectory: string | null;
  terminalLogDir?: string | null;
  pools?: PoolConfig[];
}

export interface GlobalSettings {
  defaultEditor: string | null;
  defaultTerminal: string | null;
}

export interface AppData {
  repositories: Repository[];
  repositoryConfigs: Record<string, RepositoryConfig>;
  selectedRepo: string | null;
  recentWorktrees: Record<string, string>;
  windowBounds: { width: number; height: number; x?: number; y?: number };
  worktreeTerminals: Record<string, unknown>;
  globalSettings: GlobalSettings;
}

const defaultAppData: AppData = {
  repositories: [],
  repositoryConfigs: {},
  selectedRepo: null,
  recentWorktrees: {},
  windowBounds: { width: 1200, height: 800 },
  worktreeTerminals: {},
  globalSettings: { defaultEditor: null, defaultTerminal: null },
};

// Get platform-specific data directory
function getDataPath(): string {
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
  // Write to a temp file first, then rename for atomic write
  const tmpPath = dataPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
  await fs.rename(tmpPath, dataPath);
}

export function getGlobalSettings(appData: AppData): GlobalSettings {
  return appData.globalSettings || { defaultEditor: null, defaultTerminal: null };
}

export function getRepoConfig(appData: AppData, repoPath: string): RepositoryConfig {
  return appData.repositoryConfigs[repoPath] || {
    mainBranch: null,
    initCommand: null,
    worktreeDirectory: null,
  };
}
