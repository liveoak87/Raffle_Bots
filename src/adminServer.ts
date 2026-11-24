/**
 * Tiny HTTP admin server for the consolidated control tower.
 * GET /admin/summary  (X-Admin-Key gated) → normalized BotSummary
 * GET /health         → liveness (no auth, control-tower convention)
 * GET /admin/health   → liveness (no auth, backwards compatible)
 *
 * Always-on regardless of webhook/polling mode. Raffle bot is free (no
 * subscriptions); exposed publicly via the Cloudflare tunnel.
 */
import * as http from "http";
import {
  getBotStats,
  getActiveBotGroups,
  getAdminBotGroups,
  getAdminGroupSummaries,
  getAnnouncementHealth,
} from "./database";
import { getJobStats } from "./jobs";
import { logger } from "./logger";

export function createAdminServer(key: string, transportHealthy: () => boolean = () => true): http.Server {
  return http.createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (
        req.method === "GET" &&
        (url.pathname === "/health" || url.pathname === "/admin/health")
      ) {
        const ok = transportHealthy();
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/summary") {
        if (!key || req.headers["x-admin-key"] !== key) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        const s = getBotStats();
        const announcements = getAnnouncementHealth();
        const jobs = getJobStats();
        const body = {
          bot: "raffle",
          display: "Ultimate Raffle",
          // Groups the bot is in (matches the bot's own /stats "Groups (total)"),
          // not just groups that have run a raffle (s.totalGroups).
          groups: getActiveBotGroups().length,
          subs: null,
          mrr: null,
          usage: {
            "Admin groups": getAdminBotGroups().length,
            "Total raffles": s.totalRaffles,
            "Active raffles": s.activeRaffles,
            "Entries": s.totalEntries,
            "Winners": s.totalWinners,
            "Unannounced": announcements.totalUnannounced,
            "Historical failed announcements": announcements.permanentlyFailed,
            "Failed jobs": jobs.failed,
          },
          // No durable error-event table exists, so do not report a false zero.
          errors_24h: null,
          recent_errors: [],
          webhook: null,
          healthy:
            transportHealthy() &&
            announcements.stuckOver15min === 0 &&
            jobs.failed === 0,
          generated_at: Math.floor(Date.now() / 1000),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/groups") {
        if (!key || req.headers["x-admin-key"] !== key) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        const groups = getAdminGroupSummaries();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: groups.length, groups }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      logger.error({ err }, "Admin request failed");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal server error" }));
    }
  });
}

export function startAdminServer(transportHealthy: () => boolean = () => true): http.Server {
  const key = process.env.ADMIN_KEY || "";
  const rawPort = process.env.ADMIN_PORT || "8787";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("ADMIN_PORT must be an integer between 1 and 65535");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ADMIN_PORT must be an integer between 1 and 65535");
  }

  const server = createAdminServer(key, transportHealthy);

  server.listen(port, () => logger.info({ port }, "Admin server listening"));
  return server;
}
