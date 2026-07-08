import logger from "../shared/logger.js";
import { loadAppData, getRepoConfig } from "../cli/config.js";
import { cronMatches, isValidCron } from "../shared/cron.js";
import { listRuns } from "../cli/automation-registry.js";
import { runAutomation } from "../services/automation-service.js";

const TICK_INTERVAL_MS = 60 * 1000;
// Keep dedupe keys around for a couple of minutes, well past the minute they fired for.
const DEDUPE_TTL_MS = 5 * 60 * 1000;

function flooredMinuteISO(date: Date): string {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored.toISOString();
}

export function startAutomationScheduler(): { stop: () => void } {
  let ticking = false;
  const firedKeys = new Map<string, number>(); // key -> fired-at epoch ms

  function pruneFiredKeys(now: number): void {
    for (const [key, firedAt] of firedKeys) {
      if (now - firedAt > DEDUPE_TTL_MS) firedKeys.delete(key);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      pruneFiredKeys(now.getTime());

      const appData = await loadAppData();
      for (const repo of appData.repositories) {
        try {
          const repoConfig = getRepoConfig(appData, repo.path);
          const automations = repoConfig.automations ?? [];
          for (const automation of automations) {
            const schedule = automation.schedule;
            if (!schedule?.enabled) continue;
            if (!isValidCron(schedule.cron)) continue;
            if (!cronMatches(schedule.cron, now)) continue;

            const key = `${repo.path}::${automation.id}::${flooredMinuteISO(now)}`;
            if (firedKeys.has(key)) continue;

            const runs = await listRuns({ repoPath: repo.path });
            const alreadyRunning = runs.some(
              (r) => r.automationId === automation.id && r.status === "running"
            );
            if (alreadyRunning) {
              logger.debug(
                `[automation-scheduler] skipping ${automation.name} (${repo.path}): already running`
              );
              continue;
            }

            firedKeys.set(key, now.getTime());
            logger.info(
              `[automation-scheduler] firing scheduled automation "${automation.name}" for ${repo.path} (cron: ${schedule.cron})`
            );

            runAutomation({
              repoPath: repo.path,
              automation,
              repoConfig,
              onProgress: (event) => {
                if (event.type === "error") {
                  logger.error(`[automation-scheduler] ${automation.name}: ${event.text}`);
                } else {
                  logger.debug(`[automation-scheduler] ${automation.name}: ${event.text}`);
                }
              },
            }).catch((err: unknown) => {
              logger.error(
                `[automation-scheduler] run failed for "${automation.name}" (${repo.path}): ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            });
          }
        } catch (err) {
          logger.error(`[automation-scheduler] failed processing repo ${repo.path}: ${err}`);
        }
      }
    } catch (err) {
      logger.error(`[automation-scheduler] tick failed: ${err}`);
    } finally {
      ticking = false;
    }
  }

  // Align to the next minute boundary before starting the regular interval.
  const now = Date.now();
  const msUntilNextMinute = TICK_INTERVAL_MS - (now % TICK_INTERVAL_MS);
  let interval: NodeJS.Timeout | undefined;
  const alignmentTimer = setTimeout(() => {
    tick();
    interval = setInterval(tick, TICK_INTERVAL_MS);
    interval.unref?.();
  }, msUntilNextMinute);
  alignmentTimer.unref?.();

  return {
    stop: () => {
      clearTimeout(alignmentTimer);
      if (interval) clearInterval(interval);
    },
  };
}
