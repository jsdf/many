// Generic JSON file persistence with atomic writes and file-based locking
// Reuses the same pattern as task-registry.ts

import { promises as fs, constants as fsConstants } from "fs";
import { open } from "fs/promises";
import path from "path";

const LOCK_STALE_MS = 10_000;

async function acquireLock(lockPath: string): Promise<void> {
  const maxAttempts = 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fh = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
      );
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }

      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
  }

  await fs.unlink(lockPath).catch(() => {});
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {});
}

export class JsonStore<T> {
  private filePath: string;
  private lockPath: string;
  private defaultData: T;

  constructor(filePath: string, defaultData: T) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.defaultData = defaultData;
  }

  async load(): Promise<T> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      return { ...this.defaultData, ...JSON.parse(data) };
    } catch (error: any) {
      if (error.code === "ENOENT") return { ...this.defaultData };
      throw new Error(`Failed to load ${this.filePath}: ${error.message}`);
    }
  }

  private async save(data: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  async withLock<R>(
    fn: (data: T) => Promise<{ result: R; save: boolean }>
  ): Promise<R> {
    await acquireLock(this.lockPath);
    try {
      const data = await this.load();
      const { result, save } = await fn(data);
      if (save) {
        await this.save(data);
      }
      return result;
    } finally {
      await releaseLock(this.lockPath);
    }
  }
}
