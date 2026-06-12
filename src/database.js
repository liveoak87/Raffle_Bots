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

// ── Queries ──────────────────────────────────────────────────────────────────

module.exports = {
  createRaffle(guildId, channelId, prize, price, totalSlots, createdBy, maxPicksPerUser = 0, rules = null, numWinners = 1) {
    const stmt = db.prepare(`
      INSERT INTO raffles (guild_id, channel_id, prize, price, total_slots, created_by, max_picks_per_user, rules, num_winners)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  getExtensionMessages(raffleId) {
    const row = db.prepare('SELECT extension_message_ids FROM raffles WHERE id = ?').get(raffleId);
    if (!row || !row.extension_message_ids) return [];
    try { return JSON.parse(row.extension_message_ids); } catch (_) { return []; }
  },

  pickSlot(raffleId, slotNumber, userId, username) {
    try {
      db.prepare(
        'INSERT INTO picks (raffle_id, slot_number, user_id, username) VALUES (?, ?, ?, ?)'
      ).run(raffleId, slotNumber, userId, username);
      return true;
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      console.error(`[DB] pickSlot unexpected error — raffle=${raffleId} slot=#${slotNumber}:`, e.message);
      throw e;
    }
  },

  // Transactional pick with limit enforcement
  pickSlotWithLimit(raffleId, slotNumber, userId, username, maxPicks) {
    const txn = db.transaction(() => {
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
      'UPDATE picks SET paid = 1 WHERE raffle_id = ? AND slot_number = ?'
    );
    const markMany = db.transaction((nums) => {
      const results = [];
      for (const num of nums) {
        const info = stmt.run(raffleId, num);
        results.push({ slot: num, updated: info.changes > 0 });
      }
      return results;
    });
    return markMany(slotNumbers);
  },

  markAllPaid(raffleId) {
    db.prepare('UPDATE picks SET paid = 1 WHERE raffle_id = ?').run(raffleId);
  },

  markAllUnpaid(raffleId) {
    db.prepare('UPDATE picks SET paid = 0 WHERE raffle_id = ?').run(raffleId);
  },

  togglePaid(raffleId, slotNumber) {
    db.prepare(
      'UPDATE picks SET paid = CASE WHEN paid = 0 THEN 1 ELSE 0 END WHERE raffle_id = ? AND slot_number = ?'
    ).run(raffleId, slotNumber);
  },

  removePick(raffleId, slotNumber) {
    const info = db.prepare(
      'DELETE FROM picks WHERE raffle_id = ? AND slot_number = ?'
    ).run(raffleId, slotNumber);
    console.log(`[DB] removePick — raffle=${raffleId} slot=#${slotNumber} removed=${info.changes > 0}`);
    return info.changes > 0;
  },

  getRaffleById(raffleId) {
    return db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  },

  completeRaffle(raffleId, winnerSlot, winnerUserId, winnersArray = null) {
    if (winnersArray) {
      db.prepare(
        "UPDATE raffles SET status = 'completed', winner_slot = ?, winner_user_id = ?, winners_json = ? WHERE id = ?"
      ).run(winnerSlot, winnerUserId, JSON.stringify(winnersArray), raffleId);
    } else {
      db.prepare(
        "UPDATE raffles SET status = 'completed', winner_slot = ?, winner_user_id = ? WHERE id = ?"
      ).run(winnerSlot, winnerUserId, raffleId);
    }
    console.log(`[DB] Raffle completed — id=${raffleId} winnerSlot=#${winnerSlot} winnersCount=${winnersArray ? winnersArray.length : 1}`);
  },

  cancelRaffle(raffleId) {
    db.prepare("UPDATE raffles SET status = 'cancelled' WHERE id = ?").run(raffleId);
    console.log(`[DB] Raffle cancelled — id=${raffleId}`);
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
    db.prepare(
      'UPDATE raffles SET assign_only = CASE WHEN assign_only = 0 THEN 1 ELSE 0 END WHERE id = ?'
    ).run(raffleId);
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
