const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function resolveDatabasePath() {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.env.DATABASE_PATH);
  }

  const dataPath = path.join(__dirname, '..', 'data', 'raffle.db');
  const legacyRootPath = path.join(__dirname, '..', 'raffle.db');

  if (fs.existsSync(dataPath)) return dataPath;
  if (fs.existsSync(legacyRootPath)) return legacyRootPath;
  return dataPath;
}

const dbPath = resolveDatabasePath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    prize TEXT NOT NULL,
    price TEXT,
    total_slots INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    created_by TEXT NOT NULL,
    winner_slot INTEGER,
    winner_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    max_picks_per_user INTEGER DEFAULT 0,
    rules TEXT
  );

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    slot_number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    picked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid INTEGER DEFAULT 0,
    FOREIGN KEY (raffle_id) REFERENCES raffles(id),
    UNIQUE(raffle_id, slot_number)
  );

  CREATE TABLE IF NOT EXISTS draw_sessions (
    raffle_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
    validation_mode TEXT NOT NULL CHECK (validation_mode IN ('normal', 'early')),
    started_by TEXT NOT NULL,
    pool_json TEXT,
    drawn_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (raffle_id) REFERENCES raffles(id)
  );
`);

// ── Migrations (safe for existing databases) ─────────────────────────────────

const migrations = [
  'ALTER TABLE raffles ADD COLUMN max_picks_per_user INTEGER DEFAULT 0',
  'ALTER TABLE raffles ADD COLUMN rules TEXT',
  'ALTER TABLE picks ADD COLUMN paid INTEGER DEFAULT 0',
  'ALTER TABLE raffles ADD COLUMN extension_message_id TEXT',
  'ALTER TABLE raffles ADD COLUMN extension_message_ids TEXT',
  'ALTER TABLE raffles ADD COLUMN num_winners INTEGER DEFAULT 1',
  'ALTER TABLE raffles ADD COLUMN winners_json TEXT',
  'ALTER TABLE raffles ADD COLUMN assign_only INTEGER DEFAULT 0',
];

for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// ── Indexes (for query performance, especially at 200 slots) ────────────────

const indexes = [
  'CREATE INDEX IF NOT EXISTS idx_picks_raffle_id ON picks(raffle_id)',
  'CREATE INDEX IF NOT EXISTS idx_raffles_channel_status ON raffles(channel_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_raffles_guild_status ON raffles(guild_id, status)',
];

for (const sql of indexes) {
  try { db.exec(sql); } catch (_) { /* index already exists */ }
}

function hydrateDrawSession(row) {
  if (!row) return null;
  let pool = null;
  if (row.pool_json) {
    try { pool = JSON.parse(row.pool_json); } catch (_) { pool = null; }
  }
  const drawnCount = Number(row.drawn_count) || 0;
  return {
    ...row,
    pool,
    drawnWinners: pool ? pool.slice(0, drawnCount) : [],
    remainingPicks: pool ? pool.slice(drawnCount) : []
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

module.exports = {
  createRaffle(guildId, channelId, prize, price, totalSlots, createdBy, maxPicksPerUser = 0, rules = null, numWinners = 1) {
    const stmt = db.prepare(`
      INSERT INTO raffles (guild_id, channel_id, prize, price, total_slots, status, created_by, max_picks_per_user, rules, num_winners)
      VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?)
    `);
    const id = stmt.run(guildId, channelId, prize, price, totalSlots, createdBy, maxPicksPerUser, rules, numWinners).lastInsertRowid;
    console.log(`[DB] Raffle created — id=${id} guild=${guildId} channel=${channelId} slots=${totalSlots} winners=${numWinners}`);
    return id;
  },

  getActiveRaffle(channelId) {
    return db.prepare(
      "SELECT * FROM raffles WHERE channel_id = ? AND status = 'active'"
    ).get(channelId);
  },

  getCreatingOrActiveRaffle(channelId) {
    return db.prepare(
      "SELECT * FROM raffles WHERE channel_id = ? AND status IN ('creating', 'active') ORDER BY id DESC LIMIT 1"
    ).get(channelId);
  },

  activateRaffle(raffleId) {
    const info = db.prepare(
      "UPDATE raffles SET status = 'active' WHERE id = ? AND status = 'creating' AND message_id IS NOT NULL"
    ).run(raffleId);
    return info.changes === 1;
  },

  setRaffleMessage(raffleId, messageId) {
    db.prepare('UPDATE raffles SET message_id = ? WHERE id = ?').run(messageId, raffleId);
  },

  setExtensionMessage(raffleId, messageId) {
    db.prepare('UPDATE raffles SET extension_message_id = ? WHERE id = ?').run(messageId, raffleId);
  },

  setExtensionMessages(raffleId, messageIds) {
    const json = JSON.stringify(messageIds || []);
    db.prepare('UPDATE raffles SET extension_message_ids = ? WHERE id = ?').run(json, raffleId);
  },

  replaceRaffleMessages(raffleId, messageId, extensionMessageIds) {
    const replace = db.transaction(() => {
      const json = JSON.stringify(extensionMessageIds || []);
      const firstExtensionId = extensionMessageIds?.[0] || null;
      const info = db.prepare(`
        UPDATE raffles
        SET message_id = ?, extension_message_id = ?, extension_message_ids = ?
        WHERE id = ? AND status IN ('creating', 'active')
          AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
      `).run(messageId, firstExtensionId, json, raffleId, raffleId);
      return info.changes === 1;
    });
    return replace();
  },

  getExtensionMessages(raffleId) {
    const row = db.prepare('SELECT extension_message_ids FROM raffles WHERE id = ?').get(raffleId);
    if (!row || !row.extension_message_ids) return [];
    try { return JSON.parse(row.extension_message_ids); } catch (_) { return []; }
  },

  pickSlot(raffleId, slotNumber, userId, username) {
    try {
      const info = db.prepare(`
        INSERT INTO picks (raffle_id, slot_number, user_id, username)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
          AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
      `).run(raffleId, slotNumber, userId, username, raffleId, raffleId);
      return info.changes === 1;
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      console.error(`[DB] pickSlot unexpected error — raffle=${raffleId} slot=#${slotNumber}:`, e.message);
      throw e;
    }
  },

  // Transactional pick with limit enforcement
  pickSlotWithLimit(raffleId, slotNumber, userId, username, maxPicks) {
    const txn = db.transaction(() => {
      const raffle = db.prepare("SELECT status FROM raffles WHERE id = ?").get(raffleId);
      if (!raffle || raffle.status !== 'active') return { error: 'inactive' };
      if (db.prepare('SELECT 1 FROM draw_sessions WHERE raffle_id = ?').get(raffleId)) {
        return { error: 'drawing' };
      }
      if (maxPicks > 0) {
        const row = db.prepare(
          'SELECT COUNT(*) as count FROM picks WHERE raffle_id = ? AND user_id = ?'
        ).get(raffleId, userId);
        if (row.count >= maxPicks) {
          return { error: 'limit_reached', count: row.count };
        }
      }
      try {
        db.prepare(
          'INSERT INTO picks (raffle_id, slot_number, user_id, username) VALUES (?, ?, ?, ?)'
        ).run(raffleId, slotNumber, userId, username);
        return { success: true };
      } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return { error: 'taken' };
        console.error(`[DB] pickSlotWithLimit unexpected error — raffle=${raffleId} slot=#${slotNumber}:`, e.message);
        throw e;
      }
    });
    return txn();
  },

  getSlot(raffleId, slotNumber) {
    return db.prepare(
      'SELECT * FROM picks WHERE raffle_id = ? AND slot_number = ?'
    ).get(raffleId, slotNumber);
  },

  getPicks(raffleId) {
    return db.prepare(
      'SELECT * FROM picks WHERE raffle_id = ? ORDER BY slot_number'
    ).all(raffleId);
  },

  getUserPickCount(raffleId, userId) {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM picks WHERE raffle_id = ? AND user_id = ?'
    ).get(raffleId, userId);
    return row.count;
  },

  markPaid(raffleId, slotNumbers) {
    const stmt = db.prepare(
      `UPDATE picks SET paid = 1
       WHERE raffle_id = ? AND slot_number = ?
         AND EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
         AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)`
    );
    const markMany = db.transaction((nums) => {
      const results = [];
      for (const num of nums) {
        const info = stmt.run(raffleId, num, raffleId, raffleId);
        results.push({ slot: num, updated: info.changes > 0 });
      }
      return results;
    });
    return markMany(slotNumbers);
  },

  markAllPaid(raffleId) {
    return db.prepare(`
      UPDATE picks SET paid = 1 WHERE raffle_id = ?
        AND EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
    `).run(raffleId, raffleId, raffleId).changes;
  },

  markAllUnpaid(raffleId) {
    return db.prepare(`
      UPDATE picks SET paid = 0 WHERE raffle_id = ?
        AND EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
    `).run(raffleId, raffleId, raffleId).changes;
  },

  togglePaid(raffleId, slotNumber) {
    return db.prepare(`
      UPDATE picks SET paid = CASE WHEN paid = 0 THEN 1 ELSE 0 END
      WHERE raffle_id = ? AND slot_number = ?
        AND EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
    `).run(raffleId, slotNumber, raffleId, raffleId).changes === 1;
  },

  removePick(raffleId, slotNumber) {
    const info = db.prepare(`
      DELETE FROM picks WHERE raffle_id = ? AND slot_number = ?
        AND EXISTS (SELECT 1 FROM raffles WHERE id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
    `).run(raffleId, slotNumber, raffleId, raffleId);
    console.log(`[DB] removePick — raffle=${raffleId} slot=#${slotNumber} removed=${info.changes > 0}`);
    return info.changes > 0;
  },

  getRaffleById(raffleId) {
    return db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  },

  hasDrawSession(raffleId) {
    return Boolean(db.prepare('SELECT 1 FROM draw_sessions WHERE raffle_id = ?').get(raffleId));
  },

  getDrawSession(raffleId) {
    return hydrateDrawSession(
      db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId)
    );
  },

  getAllDrawSessions() {
    return db.prepare('SELECT * FROM draw_sessions ORDER BY created_at').all().map(hydrateDrawSession);
  },

  startDrawSession(raffleId, startedBy, kind, validationMode = 'normal') {
    const start = db.transaction(() => {
      const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
      if (!raffle || raffle.status !== 'active') return { error: 'inactive' };

      const existing = db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId);
      if (existing) return { error: 'already_drawing', session: hydrateDrawSession(existing) };

      const picks = db.prepare('SELECT * FROM picks WHERE raffle_id = ? ORDER BY slot_number').all(raffleId);
      if (picks.length === 0) return { error: 'no_picks' };
      if (validationMode !== 'early' && picks.length < raffle.total_slots) {
        return { error: 'open_slots', remaining: raffle.total_slots - picks.length };
      }
      if (validationMode !== 'early') {
        const unpaidCount = picks.filter(pick => !pick.paid).length;
        if (unpaidCount > 0) return { error: 'unpaid', unpaidCount };
      }

      db.prepare(`
        INSERT INTO draw_sessions (raffle_id, kind, validation_mode, started_by)
        VALUES (?, ?, ?, ?)
      `).run(raffleId, kind, validationMode === 'early' ? 'early' : 'normal', startedBy);
      return { success: true, raffle, picks };
    });
    return start();
  },

  initializeDrawSession(raffleId, pool, drawnCount) {
    const initialize = db.transaction(() => {
      const row = db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId);
      if (!row) return { error: 'missing' };
      if (row.pool_json) return { success: true, existing: true, session: hydrateDrawSession(row) };

      const picks = db.prepare('SELECT * FROM picks WHERE raffle_id = ? ORDER BY slot_number').all(raffleId);
      const expected = picks.map(pick => pick.slot_number).sort((a, b) => a - b);
      const supplied = pool.map(pick => pick.slot_number).sort((a, b) => a - b);
      if (expected.length !== supplied.length || expected.some((slot, index) => slot !== supplied[index])) {
        return { error: 'pool_mismatch' };
      }

      const safeCount = Math.max(0, Math.min(Number(drawnCount) || 0, pool.length));
      db.prepare(`
        UPDATE draw_sessions
        SET pool_json = ?, drawn_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE raffle_id = ? AND pool_json IS NULL
      `).run(JSON.stringify(pool), safeCount, raffleId);
      return {
        success: true,
        existing: false,
        session: hydrateDrawSession(
          db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId)
        )
      };
    });
    return initialize();
  },

  advanceDrawSession(raffleId) {
    const advance = db.transaction(() => {
      const row = db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId);
      const session = hydrateDrawSession(row);
      if (!session) return { error: 'missing' };
      if (session.kind !== 'manual') return { error: 'wrong_kind' };
      if (!session.pool) return { error: 'uninitialized' };
      if (session.drawn_count >= session.pool.length) return { error: 'exhausted', session };

      db.prepare(`
        UPDATE draw_sessions
        SET drawn_count = drawn_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE raffle_id = ?
      `).run(raffleId);
      const updated = hydrateDrawSession(
        db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId)
      );
      return {
        success: true,
        winner: updated.drawnWinners[updated.drawnWinners.length - 1],
        session: updated
      };
    });
    return advance();
  },

  completeDrawSession(raffleId) {
    const complete = db.transaction(() => {
      const row = db.prepare('SELECT * FROM draw_sessions WHERE raffle_id = ?').get(raffleId);
      const session = hydrateDrawSession(row);
      if (!session) return { error: 'missing' };
      if (!session.pool || session.drawnWinners.length === 0) return { error: 'uninitialized' };

      const winners = session.drawnWinners;
      const winnersArray = winners.map(winner => ({
        slot: winner.slot_number,
        user_id: winner.user_id,
        username: winner.username
      }));
      const info = db.prepare(`
        UPDATE raffles
        SET status = 'completed', winner_slot = ?, winner_user_id = ?, winners_json = ?
        WHERE id = ? AND status = 'active'
      `).run(winners[0].slot_number, winners[0].user_id, JSON.stringify(winnersArray), raffleId);
      if (info.changes !== 1) return { error: 'inactive' };

      db.prepare('DELETE FROM draw_sessions WHERE raffle_id = ?').run(raffleId);
      console.log(`[DB] Draw session completed — id=${raffleId} winnersCount=${winners.length}`);
      return { success: true, winners, session };
    });
    return complete();
  },

  completeRaffle(raffleId, winnerSlot, winnerUserId, winnersArray = null) {
    let info;
    if (winnersArray) {
      info = db.prepare(
        "UPDATE raffles SET status = 'completed', winner_slot = ?, winner_user_id = ?, winners_json = ? WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)"
      ).run(winnerSlot, winnerUserId, JSON.stringify(winnersArray), raffleId, raffleId);
    } else {
      info = db.prepare(
        "UPDATE raffles SET status = 'completed', winner_slot = ?, winner_user_id = ? WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)"
      ).run(winnerSlot, winnerUserId, raffleId, raffleId);
    }
    if (info.changes !== 1) return false;
    console.log(`[DB] Raffle completed — id=${raffleId} winnerSlot=#${winnerSlot} winnersCount=${winnersArray ? winnersArray.length : 1}`);
    return true;
  },

  cancelRaffle(raffleId) {
    const info = db.prepare(
      "UPDATE raffles SET status = 'cancelled' WHERE id = ? AND status IN ('creating', 'active') AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)"
    ).run(raffleId, raffleId);
    if (info.changes === 1) console.log(`[DB] Raffle cancelled — id=${raffleId}`);
    return info.changes === 1;
  },

  // ── Dashboard queries ──────────────────────────────────────────────────────

  getAllGuilds() {
    return db.prepare(`
      SELECT guild_id,
             COUNT(*) as raffle_count,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
             SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
             MAX(created_at) as last_raffle
      FROM raffles
      GROUP BY guild_id
      ORDER BY last_raffle DESC
    `).all();
  },

  getGuildRaffles(guildId) {
    return db.prepare(`
      SELECT * FROM raffles
      WHERE guild_id = ?
      ORDER BY created_at DESC
    `).all(guildId);
  },

  getAllRaffles(limit = 50) {
    return db.prepare(`
      SELECT * FROM raffles
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  },

  getStats() {
    return db.prepare(`
      SELECT
        COUNT(DISTINCT guild_id) as total_guilds,
        COUNT(*) as total_raffles,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_raffles,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_raffles,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_raffles
      FROM raffles
    `).get();
  },

  toggleAssignOnly(raffleId) {
    return db.prepare(`
      UPDATE raffles SET assign_only = CASE WHEN assign_only = 0 THEN 1 ELSE 0 END
      WHERE id = ? AND status IN ('creating', 'active')
        AND NOT EXISTS (SELECT 1 FROM draw_sessions WHERE raffle_id = ?)
    `).run(raffleId, raffleId).changes === 1;
  },

  getAllActiveRaffles() {
    return db.prepare(`
      SELECT r.*, COUNT(p.id) as pick_count
      FROM raffles r
      LEFT JOIN picks p ON p.raffle_id = r.id
      WHERE r.status = 'active'
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `).all();
  },

  getRaffleWithPicks(raffleId) {
    const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
    if (!raffle) return null;
    const picks = db.prepare('SELECT * FROM picks WHERE raffle_id = ? ORDER BY slot_number').all(raffleId);
    return { ...raffle, picks };
  },

  close() {
    db.close();
  }
};
