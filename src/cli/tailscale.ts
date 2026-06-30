import { exec } from "node:child_process";
import { promisify } from "node:util";
import logger from "../shared/logger.js";

const execAsync = promisify(exec);

/**
 * Proxy the tailnet HTTPS (443) endpoint to a local port via `tailscale serve`.
 * Returns the public tailnet base URL (e.g. https://machine.tailnet.ts.net),
 * or null if tailscale is unavailable or the command failed.
 */
export async function startTailscaleServe(localPort: number): Promise<string | null> {
  try {
    await execAsync(`tailscale serve --bg --https=443 ${localPort}`);
  } catch (error) {
    logger.warn(`tailscale serve failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return getTailnetBaseUrl();
}

/** Remove the tailnet HTTPS (443) serve handler. Best-effort. */
export async function stopTailscaleServe(): Promise<void> {
  try {
    await execAsync(`tailscale serve --https=443 off`);
  } catch (error) {
    logger.warn(`tailscale serve off failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getTailnetBaseUrl(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`tailscale status --json`);
    const status = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName;
    if (!dnsName) return null;
    return `https://${dnsName.replace(/\.$/, "")}`;
  } catch {
    return null;
  }
}
