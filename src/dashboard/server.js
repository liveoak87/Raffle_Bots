const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { setupRoutes } = require('./routes');

// Never fall back to a public, source-visible session secret (it would let anyone
// forge an authenticated cookie). Prefer the configured secret; if it's missing,
// generate a strong random one for this process rather than crashing the bot —
// the only cost is that existing dashboard logins don't survive a restart.
function resolveSessionSecret() {
  const configured = process.env.DASHBOARD_SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;
  console.warn('[DASHBOARD] DASHBOARD_SESSION_SECRET not set (or too short) — generating a random per-process secret. Set it in .env for persistent sessions.');
  return crypto.randomBytes(48).toString('hex');
}

// Discord name resolver with cache
class NameResolver {
  constructor(client) {
    this.client = client;
    this.cache = new Map();
    this.TTL = 5 * 60 * 1000; // 5 minutes
  }

  getCached(id) {
    const entry = this.cache.get(id);
    if (entry && Date.now() - entry.ts < this.TTL) return entry.name;
    return null;
  }

  async getGuildName(guildId) {
    const cached = this.getCached(guildId);
    if (cached) return cached;
    try {
      const guild = await this.client.guilds.fetch(guildId);
      this.cache.set(guildId, { name: guild.name, ts: Date.now() });
      return guild.name;
    } catch (_) {
      return `Unknown Server (${guildId})`;
    }
  }

  async getChannelName(channelId) {
    const cached = this.getCached(channelId);
    if (cached) return cached;
    try {
      const channel = await this.client.channels.fetch(channelId);
      const name = channel.name || channelId;
      this.cache.set(channelId, { name, ts: Date.now() });
      return name;
    } catch (_) {
      return `Unknown Channel (${channelId})`;
    }
  }

  async resolveGuilds(guildIds) {
    const unique = [...new Set(guildIds)];
    await Promise.all(unique.map(id => this.getGuildName(id)));
  }
}

let httpServer = null;

function start(client, db) {
  const app = express();
  const port = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;

  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' } // 24 hours
  }));

  const resolver = new NameResolver(client);
  setupRoutes(app, db, resolver);

  httpServer = app.listen(port, () => {
    console.log(`Dashboard running on http://localhost:${port}`);
  });
}

function stop() {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

module.exports = { start, stop };
