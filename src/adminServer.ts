/**
 * Tiny HTTP admin server for the consolidated control tower.
 * GET /admin/summary  (X-Admin-Key gated) → normalized BotSummary
 * GET /admin/health   → liveness (no auth)
 *
 * Always-on regardless of webhook/polling mode. Raffle bot is free (no
 * subscriptions); exposed publicly via the Cloudflare tunnel.
 */
import * as http from "http";
import { getBotStats, getActiveBotGroups, getAdminBotGroups } from "./database";
import { logger } from "./logger";

export function startAdminServer(): void {
  const key = process.env.ADMIN_KEY || "";
  const port = Number(process.env.ADMIN_PORT || 8787);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/admin/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/summary") {
        if (!key || req.headers["x-admin-key"] !== key) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        const s = getBotStats();
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
          },
          errors_24h: 0,
          recent_errors: [],
          webhook: null,
          healthy: true,
          generated_at: Math.floor(Date.now() / 1000),
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e: any) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });

  server.listen(port, () => logger.info({ port }, "Admin server listening"));
}
