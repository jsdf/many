import { execSync } from "child_process";
import logger from "../shared/logger.js";
import { loadAppData } from "../cli/config.js";
import { getTrackedBranches, addTrackedBranch } from "../cli/db.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function pollAssignedPrs(): Promise<void> {
  try {
    const appData = await loadAppData();
    for (const repo of appData.repositories) {
      try {
        const output = execSync(
          'gh pr list --assignee @me --json headRefName --jq ".[].headRefName"',
          { cwd: repo.path, encoding: "utf-8", timeout: 15000 }
        ).trim();
        if (!output) continue;
        const branches = output.split("\n").filter(Boolean);
        const existing = new Set(getTrackedBranches(repo.path));
        for (const branch of branches) {
          if (!existing.has(branch)) {
            addTrackedBranch(repo.path, branch);
            logger.info(`[tracked] auto-added assigned PR branch: ${branch} (${repo.path})`);
          }
        }
      } catch {
        // gh not available or not authenticated for this repo - skip
      }
    }
  } catch (err) {
    logger.debug(`[tracked] poll assigned PRs failed: ${err}`);
  }
}

export function startTrackedPoller(): { stop: () => void } {
  pollAssignedPrs();
  const interval = setInterval(pollAssignedPrs, POLL_INTERVAL_MS);
  return {
    stop: () => clearInterval(interval),
  };
}
