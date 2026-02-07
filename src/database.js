const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'raffle.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER NOT NULL,
    slot_number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    picked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (raffle_id) REFERENCES raffles(id),
    UNIQUE(raffle_id, slot_number)
  );
`);

module.exports = {
  createRaffle(guildId, channelId, prize, price, totalSlots, createdBy) {
    const stmt = db.prepare(`
      INSERT INTO raffles (guild_id, channel_id, prize, price, total_slots, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(guildId, channelId, prize, price, totalSlots, createdBy).lastInsertRowid;
  },

  getActiveRaffle(channelId) {
    return db.prepare(
      "SELECT * FROM raffles WHERE channel_id = ? AND status = 'active'"
    ).get(channelId);
  },

  setRaffleMessage(raffleId, messageId) {
    db.prepare('UPDATE raffles SET message_id = ? WHERE id = ?').run(messageId, raffleId);
  },

  pickSlot(raffleId, slotNumber, userId, username) {
    try {
      db.prepare(
        'INSERT INTO picks (raffle_id, slot_number, user_id, username) VALUES (?, ?, ?, ?)'
      ).run(raffleId, slotNumber, userId, username);
      return true;
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw e;
    }
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

  completeRaffle(raffleId, winnerSlot, winnerUserId) {
    db.prepare(
      "UPDATE raffles SET status = 'completed', winner_slot = ?, winner_user_id = ? WHERE id = ?"
    ).run(winnerSlot, winnerUserId, raffleId);
  },

  cancelRaffle(raffleId) {
    db.prepare("UPDATE raffles SET status = 'cancelled' WHERE id = ?").run(raffleId);
  },

  close() {
    db.close();
  }
};
