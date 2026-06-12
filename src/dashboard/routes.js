const { spawn } = require('child_process');
const path = require('path');
const views = require('./views');

function setupRoutes(app, db, resolver) {
  // ── Simple in-memory login rate limiter (no extra dependency) ──────────────
  // Locks a client IP after too many failed password attempts to blunt brute force.
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 15 * 60 * 1000;
  const loginAttempts = new Map(); // ip -> { count, first, lockedUntil }

  function loginLockRemaining(ip) {
    const entry = loginAttempts.get(ip);
    if (entry && entry.lockedUntil && entry.lockedUntil > Date.now()) {
      return Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    }
    return 0;
  }
  function recordLoginFailure(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip) || { count: 0, first: now, lockedUntil: 0 };
    if (now - entry.first > LOCKOUT_MS) { entry.count = 0; entry.first = now; }
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS;
    loginAttempts.set(ip, entry);
  }
  function clearLoginFailures(ip) { loginAttempts.delete(ip); }

  // Auth middleware
  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.redirect('/login');
  }

  // Login
  app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) return res.redirect('/');
    res.send(views.loginPage());
  });

  app.post('/login', (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const lockMins = loginLockRemaining(ip);
    if (lockMins > 0) {
      return res.send(views.loginPage(`Too many attempts. Try again in ${lockMins} minute(s).`));
    }
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) return res.send(views.loginPage('Dashboard password not set in .env'));
    if (req.body.password === password) {
      clearLoginFailures(ip);
      req.session.authenticated = true;
      return res.redirect('/');
    }
    recordLoginFailure(ip);
    res.send(views.loginPage('Incorrect password'));
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  // Liveness/readiness probe (public, no auth). Returns 200 only when the
  // Discord gateway is actually connected — so a "zombie" (Node up but gateway
  // dead) reports unhealthy and the Docker HEALTHCHECK / monitor can restart it.
  app.get('/health', (req, res) => {
    const client = resolver.client;
    const ready = !!(client && client.isReady());
    const ping = client && client.ws ? Math.round(client.ws.ping) : -1;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'unhealthy',
      gateway: ready ? 'connected' : 'disconnected',
      ping_ms: ping,
      uptime_s: Math.round(process.uptime())
    });
  });

  // Public legal pages for Discord application verification
  app.get('/terms', (req, res) => {
    res.send(views.termsPage());
  });

  app.get('/privacy', (req, res) => {
    res.send(views.privacyPage());
  });

  // Restart bot
  app.post('/restart', requireAuth, (req, res) => {
    res.send(views.restartingPage());
    console.log('[DASHBOARD] Restart requested — spawning new process...');
    const entry = path.resolve(__dirname, '..', 'index.js');
    const child = spawn(process.execPath, [entry], {
      cwd: path.resolve(__dirname, '..', '..'),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();
    setTimeout(() => process.exit(0), 500);
  });

  // Home
  app.get('/', requireAuth, async (req, res) => {
    try {
      const stats = db.getStats();
      // Use actual bot guild count instead of DB-only count
      stats.total_guilds = resolver.client.guilds.cache.size;
      const recent = db.getAllRaffles(20);
      await resolver.resolveGuilds(recent.map(r => r.guild_id));
      res.send(views.homePage(stats, recent, resolver));
    } catch (err) {
      console.error('Dashboard error (home):', err.message);
      res.status(500).send('Server error');
    }
  });

  // Servers list — merges bot's actual guild list with DB raffle data
  app.get('/servers', requireAuth, async (req, res) => {
    try {
      const dbGuilds = db.getAllGuilds();
      const dbMap = new Map(dbGuilds.map(g => [g.guild_id, g]));

      // Get all guilds the bot is actually in
      const botGuilds = resolver.client.guilds.cache;
      const allGuilds = [];

      for (const [guildId, guild] of botGuilds) {
        const dbEntry = dbMap.get(guildId);
        allGuilds.push({
          guild_id: guildId,
          raffle_count: dbEntry ? dbEntry.raffle_count : 0,
          active_count: dbEntry ? dbEntry.active_count : 0,
          completed_count: dbEntry ? dbEntry.completed_count : 0,
          last_raffle: dbEntry ? dbEntry.last_raffle : '—'
        });
        // Cache the guild name from the live guild object
        resolver.cache.set(guildId, { name: guild.name, ts: Date.now() });
      }

      // Also include any DB guilds the bot is no longer in
      for (const g of dbGuilds) {
        if (!botGuilds.has(g.guild_id)) {
          allGuilds.push(g);
        }
      }

      res.send(views.serversPage(allGuilds, resolver));
    } catch (err) {
      console.error('Dashboard error (servers):', err.message);
      res.status(500).send('Server error');
    }
  });

  // Single server
  app.get('/server/:guildId', requireAuth, async (req, res) => {
    try {
      const raffles = db.getGuildRaffles(req.params.guildId);
      if (raffles.length === 0) return res.status(404).send(views.notFoundPage());
      const guildName = await resolver.getGuildName(req.params.guildId);
      res.send(views.serverPage(req.params.guildId, guildName, raffles));
    } catch (err) {
      console.error('Dashboard error (server):', err.message);
      res.status(500).send('Server error');
    }
  });

  // Raffle detail
  app.get('/raffle/:raffleId', requireAuth, async (req, res) => {
    try {
      const data = db.getRaffleWithPicks(parseInt(req.params.raffleId, 10));
      if (!data) return res.status(404).send(views.notFoundPage());
      const guildName = await resolver.getGuildName(data.guild_id);
      const channelName = await resolver.getChannelName(data.channel_id);
      res.send(views.rafflePage(data, guildName, channelName));
    } catch (err) {
      console.error('Dashboard error (raffle):', err.message);
      res.status(500).send('Server error');
    }
  });

  // 404
  app.use(requireAuth, (req, res) => {
    res.status(404).send(views.notFoundPage());
  });
}

module.exports = { setupRoutes };
