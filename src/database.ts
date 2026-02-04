import Database from "better-sqlite3";
import type {
  Raffle,
  RaffleEntry,
  RaffleWinner,
  CreateRaffleInput,
} from "./types";

let db: Database.Database;

export function initDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS raffles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      creator_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prize TEXT NOT NULL,
      max_entries INTEGER,
      max_winners INTEGER NOT NULL DEFAULT 1,
      ends_at TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'drawn')),
      message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      drawn_at TEXT
    );

    CREATE TABLE IF NOT EXISTS raffle_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raffle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_display_name TEXT NOT NULL,
      entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id) ON DELETE CASCADE,
      UNIQUE(raffle_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS raffle_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raffle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      user_display_name TEXT NOT NULL,
      selected_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_raffles_chat_id ON raffles(chat_id);
    CREATE INDEX IF NOT EXISTS idx_raffles_status ON raffles(status);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle_id ON raffle_entries(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_user_id ON raffle_entries(user_id);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase first.");
  }
  return db;
}

// --- Raffle CRUD ---

export function createRaffle(input: CreateRaffleInput): Raffle {
  const stmt = getDb().prepare(`
    INSERT INTO raffles (chat_id, creator_id, creator_name, title, description, prize, max_entries, max_winners, ends_at)
    VALUES (@chat_id, @creator_id, @creator_name, @title, @description, @prize, @max_entries, @max_winners, @ends_at)
  `);
  const result = stmt.run(input);
  return getRaffleById(result.lastInsertRowid as number)!;
}

export function getRaffleById(id: number): Raffle | undefined {
  return getDb()
    .prepare("SELECT * FROM raffles WHERE id = ?")
    .get(id) as Raffle | undefined;
}

export function getOpenRafflesForChat(chatId: number): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE chat_id = ? AND status = 'open' ORDER BY created_at DESC"
    )
    .all(chatId) as Raffle[];
}

export function getRecentRafflesForChat(
  chatId: number,
  limit: number = 10
): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(chatId, limit) as Raffle[];
}

export function updateRaffleMessageId(
  raffleId: number,
  messageId: number
): void {
  getDb()
    .prepare("UPDATE raffles SET message_id = ? WHERE id = ?")
    .run(messageId, raffleId);
}

export function closeRaffle(raffleId: number): void {
  getDb()
    .prepare("UPDATE raffles SET status = 'closed' WHERE id = ?")
    .run(raffleId);
}

export function markRaffleDrawn(raffleId: number): void {
  getDb()
    .prepare(
      "UPDATE raffles SET status = 'drawn', drawn_at = datetime('now') WHERE id = ?"
    )
    .run(raffleId);
}

export function deleteRaffle(raffleId: number): void {
  getDb().prepare("DELETE FROM raffles WHERE id = ?").run(raffleId);
}

// --- Entries ---

export function addEntry(
  raffleId: number,
  userId: number,
  userName: string,
  displayName: string
): { success: boolean; reason?: string } {
  const raffle = getRaffleById(raffleId);
  if (!raffle) return { success: false, reason: "Raffle not found." };
  if (raffle.status !== "open")
    return { success: false, reason: "This raffle is no longer open." };

  if (raffle.ends_at && new Date(raffle.ends_at + "Z") < new Date()) {
    return { success: false, reason: "This raffle has expired." };
  }

  if (raffle.max_entries) {
    const count = getEntryCount(raffleId);
    if (count >= raffle.max_entries) {
      return { success: false, reason: "This raffle is full." };
    }
  }

  try {
    getDb()
      .prepare(
        `INSERT INTO raffle_entries (raffle_id, user_id, user_name, user_display_name)
         VALUES (?, ?, ?, ?)`
      )
      .run(raffleId, userId, userName, displayName);
    return { success: true };
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { success: false, reason: "You already entered this raffle!" };
    }
    throw err;
  }
}

export function removeEntry(raffleId: number, userId: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM raffle_entries WHERE raffle_id = ? AND user_id = ?")
    .run(raffleId, userId);
  return result.changes > 0;
}

export function getEntriesForRaffle(raffleId: number): RaffleEntry[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffle_entries WHERE raffle_id = ? ORDER BY entered_at ASC"
    )
    .all(raffleId) as RaffleEntry[];
}

export function getEntryCount(raffleId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM raffle_entries WHERE raffle_id = ?"
    )
    .get(raffleId) as { count: number };
  return row.count;
}

export function hasUserEntered(raffleId: number, userId: number): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM raffle_entries WHERE raffle_id = ? AND user_id = ?"
    )
    .get(raffleId, userId) as { count: number };
  return row.count > 0;
}

// --- Winners ---

export function selectWinners(raffleId: number): RaffleWinner[] {
  const raffle = getRaffleById(raffleId);
  if (!raffle) return [];

  const entries = getEntriesForRaffle(raffleId);
  if (entries.length === 0) return [];

  const numWinners = Math.min(raffle.max_winners, entries.length);
  const selected = cryptoShuffle(entries).slice(0, numWinners);

  const insertStmt = getDb().prepare(`
    INSERT INTO raffle_winners (raffle_id, user_id, user_name, user_display_name)
    VALUES (?, ?, ?, ?)
  `);

  const insertAll = getDb().transaction(() => {
    for (const entry of selected) {
      insertStmt.run(
        raffleId,
        entry.user_id,
        entry.user_name,
        entry.user_display_name
      );
    }
    markRaffleDrawn(raffleId);
  });

  insertAll();

  return getWinnersForRaffle(raffleId);
}

export function getWinnersForRaffle(raffleId: number): RaffleWinner[] {
  return getDb()
    .prepare("SELECT * FROM raffle_winners WHERE raffle_id = ?")
    .all(raffleId) as RaffleWinner[];
}

// --- Expired raffle check ---

export function getExpiredOpenRaffles(): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE status = 'open' AND ends_at IS NOT NULL AND ends_at <= datetime('now')"
    )
    .all() as Raffle[];
}

// --- Utility ---

function cryptoShuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  const crypto = require("crypto");
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomBytes = crypto.randomBytes(4);
    const randomValue = randomBytes.readUInt32BE(0);
    const j = randomValue % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
