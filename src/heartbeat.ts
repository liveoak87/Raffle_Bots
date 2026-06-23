/**
 * Heartbeat / uptime ping.
 *
 * Pings HEARTBEAT_URL every HEARTBEAT_INTERVAL_MS. If pings stop arriving
 * at the external service (Healthchecks.io, UptimeRobot, BetterUptime, etc),
 * that service alerts you — independent of whether you remember to check on the bot.
 *
 * Configuration via env vars:
 *   HEARTBEAT_URL          - Full URL to ping (GET). Disabled if unset.
 *   HEARTBEAT_INTERVAL_MS  - Default 5 minutes. Match this to your service's
 *                            expected interval (Healthchecks.io free = 1m–24h).
 *
 * The external service should be configured to alert if no ping arrives
 * within ~2x the interval (so a single missed ping doesn't trigger).
 */

import { logger } from "./logger";

const log = logger.child({ component: "heartbeat" });

const HEARTBEAT_URL = process.env.HEARTBEAT_URL || "";
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS || String(5 * 60 * 1000),
  10
);

let lastPingOk = true;

export async function sendHeartbeat(): Promise<void> {
  if (!HEARTBEAT_URL) return;

  try {
    // 15s timeout — heartbeat services are typically very fast
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(HEARTBEAT_URL, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      log.warn({ status: res.status }, "Heartbeat ping returned non-2xx");
      lastPingOk = false;
      return;
    }

    if (!lastPingOk) {
      // Recovery — log it so we can see in history that we came back
      log.info({}, "Heartbeat ping recovered");
    }
    lastPingOk = true;
  } catch (err) {
    log.warn({ err }, "Heartbeat ping failed");
    lastPingOk = false;
  }
}

export function startHeartbeat(): { intervalMs: number; configured: boolean } {
  if (!HEARTBEAT_URL) {
    log.info({}, "Heartbeat disabled (HEARTBEAT_URL not set)");
    return { intervalMs: HEARTBEAT_INTERVAL_MS, configured: false };
  }

  // Send one immediately on startup so the monitor sees we're alive
  sendHeartbeat().catch(() => {});

  setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  log.info(
    {
      interval_minutes: Math.round(HEARTBEAT_INTERVAL_MS / 60_000),
      url_host: (() => {
        try {
          return new URL(HEARTBEAT_URL).host;
        } catch {
          return "(invalid URL)";
        }
      })(),
    },
    "Heartbeat enabled"
  );

  return { intervalMs: HEARTBEAT_INTERVAL_MS, configured: true };
}
