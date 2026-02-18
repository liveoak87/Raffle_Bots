import Database from "better-sqlite3";
import type {
  Raffle,
  RaffleEntry,
  RaffleWinner,
  CreateRaffleInput,
  RaffleTemplate,
  ReferralLink,
} from "./types";
import { getPrizeForPosition } from "./types";

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
      prizes TEXT,
      max_entries INTEGER,
      max_winners INTEGER NOT NULL DEFAULT 1,
      ends_at TEXT,
      starts_at TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'drawn')),
      message_id INTEGER,
      required_chat_id INTEGER,
      required_chat_title TEXT,
      sponsor_name TEXT,
      anonymous INTEGER NOT NULL DEFAULT 0,
      image_file_id TEXT,
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
      prize TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      selected_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS raffle_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      prize TEXT NOT NULL,
      prizes TEXT,
      max_entries INTEGER,
      max_winners INTEGER NOT NULL DEFAULT 1,
      duration_minutes INTEGER,
      sponsor_name TEXT,
      anonymous INTEGER NOT NULL DEFAULT 0,
      recurring_interval_minutes INTEGER,
      recurring_active INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chat_id, name)
    );

    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id INTEGER PRIMARY KEY,
      language TEXT NOT NULL DEFAULT 'en',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS banner_cache (
      banner_type TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS referral_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raffle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_display_name TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      invite_link TEXT NOT NULL,
      bonus_entries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id) ON DELETE CASCADE,
      UNIQUE(raffle_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_raffles_chat_id ON raffles(chat_id);
    CREATE INDEX IF NOT EXISTS idx_raffles_status ON raffles(status);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle_id ON raffle_entries(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_user_id ON raffle_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_templates_chat_id ON raffle_templates(chat_id);
    CREATE INDEX IF NOT EXISTS idx_referral_links_invite ON referral_links(invite_link);
    CREATE INDEX IF NOT EXISTS idx_referral_links_raffle ON referral_links(raffle_id);
  `);

  // Run migrations for existing databases
  migrateDatabase();

  return db;
}

function migrateDatabase(): void {
  const tableInfo = (table: string) =>
    getDb()
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;

  const raffleColumns = tableInfo("raffles").map((c) => c.name);
  const winnerColumns = tableInfo("raffle_winners").map((c) => c.name);

  if (!raffleColumns.includes("prizes")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN prizes TEXT");
  }
  if (!raffleColumns.includes("required_chat_id")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN required_chat_id INTEGER");
  }
  if (!raffleColumns.includes("required_chat_title")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN required_chat_title TEXT");
  }
  if (!raffleColumns.includes("sponsor_name")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN sponsor_name TEXT");
  }
  if (!raffleColumns.includes("starts_at")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN starts_at TEXT");
  }
  if (!raffleColumns.includes("anonymous")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("image_file_id")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN image_file_id TEXT");
  }
  if (!winnerColumns.includes("prize")) {
    getDb().exec(
      "ALTER TABLE raffle_winners ADD COLUMN prize TEXT NOT NULL DEFAULT ''"
    );
  }
  if (!winnerColumns.includes("position")) {
    getDb().exec(
      "ALTER TABLE raffle_winners ADD COLUMN position INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("auto_pin")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN auto_pin INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("min_account_age_days")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN min_account_age_days INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("require_username")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN require_username INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("winner_cooldown")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN winner_cooldown INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("show_animation")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN show_animation INTEGER NOT NULL DEFAULT 1"
    );
  }
  if (!raffleColumns.includes("referral_enabled")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN referral_enabled INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("max_referral_entries")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN max_referral_entries INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("revoke_referral_links")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN revoke_referral_links INTEGER NOT NULL DEFAULT 0"
    );
  }

  // Create referral_links table if it doesn't exist
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS referral_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raffle_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_display_name TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      invite_link TEXT NOT NULL,
      bonus_entries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (raffle_id) REFERENCES raffles(id) ON DELETE CASCADE,
      UNIQUE(raffle_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_referral_links_invite ON referral_links(invite_link);
    CREATE INDEX IF NOT EXISTS idx_referral_links_raffle ON referral_links(raffle_id);
  `);
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
    INSERT INTO raffles (chat_id, creator_id, creator_name, title, description, prize, prizes, max_entries, max_winners, ends_at, starts_at, required_chat_id, required_chat_title, sponsor_name, anonymous, image_file_id, auto_pin, min_account_age_days, require_username, winner_cooldown, show_animation, referral_enabled, max_referral_entries, revoke_referral_links)
    VALUES (@chat_id, @creator_id, @creator_name, @title, @description, @prize, @prizes, @max_entries, @max_winners, @ends_at, @starts_at, @required_chat_id, @required_chat_title, @sponsor_name, @anonymous, @image_file_id, @auto_pin, @min_account_age_days, @require_username, @winner_cooldown, @show_animation, @referral_enabled, @max_referral_entries, @revoke_referral_links)
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
): { success: boolean; reason?: string; maxReached?: boolean } {
  const raffle = getRaffleById(raffleId);
  if (!raffle) return { success: false, reason: "Raffle not found." };
  if (raffle.status !== "open")
    return { success: false, reason: "This raffle is no longer open." };

  if (raffle.ends_at && new Date(raffle.ends_at + "Z") < new Date()) {
    return { success: false, reason: "This raffle has expired." };
  }

  // Check scheduled start time
  if (raffle.starts_at && new Date(raffle.starts_at + "Z") > new Date()) {
    return { success: false, reason: "This raffle hasn't opened yet." };
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

    // Check if max entries reached after this insert
    const maxReached =
      raffle.max_entries !== null &&
      getEntryCount(raffleId) >= raffle.max_entries;

    return { success: true, maxReached };
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      const messages = [
        "Look, we get it. Free stuff hits different. But you already threw your name in this one, you eager beaver.",
        "Your enthusiasm for free things is noted and respected. But you already entered this one, champ.",
        "We love the energy, but you already snagged your spot in this one. Save some luck for the rest of us.",
        "Easy there, tiger. You already entered this one. We admire the hustle though.",
      ];
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      return { success: false, reason: randomMessage };
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

// --- Bulk insert entries (for rerun) ---

export function bulkAddEntries(
  raffleId: number,
  entries: Array<{ user_id: number; user_name: string; user_display_name: string }>
): number {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO raffle_entries (raffle_id, user_id, user_name, user_display_name)
    VALUES (?, ?, ?, ?)
  `);

  let added = 0;
  const insertAll = getDb().transaction(() => {
    for (const entry of entries) {
      const result = stmt.run(
        raffleId,
        entry.user_id,
        entry.user_name,
        entry.user_display_name
      );
      if (result.changes > 0) added++;
    }
  });

  insertAll();
  return added;
}

// --- Winners ---

export function selectWinners(raffleId: number): RaffleWinner[] {
  const raffle = getRaffleById(raffleId);
  if (!raffle) return [];

  // Check if winners were already selected (e.g. from a previous failed announcement)
  const existing = getWinnersForRaffle(raffleId);
  if (existing.length > 0) return existing;

  const entries = getEntriesForRaffle(raffleId);
  if (entries.length === 0) return [];

  const numWinners = Math.min(raffle.max_winners, entries.length);

  // Build weighted entry pool if referral entries are enabled
  let pool: RaffleEntry[];
  if (raffle.referral_enabled) {
    pool = [];
    for (const entry of entries) {
      // 1 base entry
      pool.push(entry);
      // Add bonus entries from referrals
      const bonus = getBonusEntries(raffleId, entry.user_id);
      for (let i = 0; i < bonus; i++) {
        pool.push(entry);
      }
    }
  } else {
    pool = entries;
  }

  // Shuffle and pick unique winners
  const shuffled = cryptoShuffle(pool);
  const selected: RaffleEntry[] = [];
  const selectedIds = new Set<number>();
  for (const entry of shuffled) {
    if (selectedIds.has(entry.user_id)) continue;
    selectedIds.add(entry.user_id);
    selected.push(entry);
    if (selected.length >= numWinners) break;
  }

  const insertStmt = getDb().prepare(`
    INSERT INTO raffle_winners (raffle_id, user_id, user_name, user_display_name, prize, position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAll = getDb().transaction(() => {
    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      const prize = getPrizeForPosition(raffle, i);
      insertStmt.run(
        raffleId,
        entry.user_id,
        entry.user_name,
        entry.user_display_name,
        prize,
        i + 1
      );
    }
  });

  insertAll();

  return getWinnersForRaffle(raffleId);
}

export function getWinnersForRaffle(raffleId: number): RaffleWinner[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffle_winners WHERE raffle_id = ? ORDER BY position ASC"
    )
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

export function getOpenRafflesWithEndTime(): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE status = 'open' AND ends_at IS NOT NULL AND message_id IS NOT NULL AND ends_at > datetime('now')"
    )
    .all() as Raffle[];
}

// --- Templates ---

export function createTemplate(input: {
  chat_id: number;
  creator_id: number;
  name: string;
  title: string;
  prize: string;
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  duration_minutes: number | null;
  sponsor_name: string | null;
  anonymous: number;
  recurring_interval_minutes: number | null;
}): RaffleTemplate {
  const stmt = getDb().prepare(`
    INSERT INTO raffle_templates (chat_id, creator_id, name, title, prize, prizes, max_entries, max_winners, duration_minutes, sponsor_name, anonymous, recurring_interval_minutes, recurring_active, next_run_at)
    VALUES (@chat_id, @creator_id, @name, @title, @prize, @prizes, @max_entries, @max_winners, @duration_minutes, @sponsor_name, @anonymous, @recurring_interval_minutes, 0, NULL)
  `);
  const result = stmt.run(input);
  return getDb()
    .prepare("SELECT * FROM raffle_templates WHERE id = ?")
    .get(result.lastInsertRowid) as RaffleTemplate;
}

export function getTemplatesForChat(chatId: number): RaffleTemplate[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffle_templates WHERE chat_id = ? ORDER BY name ASC"
    )
    .all(chatId) as RaffleTemplate[];
}

export function getTemplateByName(
  chatId: number,
  name: string
): RaffleTemplate | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM raffle_templates WHERE chat_id = ? AND name = ? COLLATE NOCASE"
    )
    .get(chatId, name) as RaffleTemplate | undefined;
}

export function deleteTemplate(chatId: number, name: string): boolean {
  const result = getDb()
    .prepare(
      "DELETE FROM raffle_templates WHERE chat_id = ? AND name = ? COLLATE NOCASE"
    )
    .run(chatId, name);
  return result.changes > 0;
}

export function getTemplateById(
  templateId: number
): RaffleTemplate | undefined {
  return getDb()
    .prepare("SELECT * FROM raffle_templates WHERE id = ?")
    .get(templateId) as RaffleTemplate | undefined;
}

export function deleteTemplateById(templateId: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM raffle_templates WHERE id = ?")
    .run(templateId);
  return result.changes > 0;
}

export function setRecurringActive(
  templateId: number,
  active: boolean,
  nextRunAt: string | null
): void {
  getDb()
    .prepare(
      "UPDATE raffle_templates SET recurring_active = ?, next_run_at = ? WHERE id = ?"
    )
    .run(active ? 1 : 0, nextRunAt, templateId);
}

export function getDueRecurringTemplates(): RaffleTemplate[] {
  return getDb()
    .prepare(
      `SELECT * FROM raffle_templates
       WHERE recurring_active = 1
         AND recurring_interval_minutes IS NOT NULL
         AND next_run_at IS NOT NULL
         AND next_run_at <= datetime('now')`
    )
    .all() as RaffleTemplate[];
}

export function updateNextRunAt(
  templateId: number,
  nextRunAt: string
): void {
  getDb()
    .prepare("UPDATE raffle_templates SET next_run_at = ? WHERE id = ?")
    .run(nextRunAt, templateId);
}

// --- Winner cooldown check ---

/**
 * Check if a user has won any raffle in this chat within the last N raffles.
 * Returns the raffle title they won if found, or null.
 */
export function getRecentWin(
  chatId: number,
  userId: number,
  lookbackCount: number
): string | null {
  if (lookbackCount <= 0) return null;

  const row = getDb()
    .prepare(
      `SELECT r.title FROM raffle_winners w
       JOIN raffles r ON w.raffle_id = r.id
       WHERE r.chat_id = ? AND w.user_id = ?
         AND r.status = 'drawn'
         AND r.id IN (
           SELECT id FROM raffles
           WHERE chat_id = ? AND status = 'drawn'
           ORDER BY drawn_at DESC LIMIT ?
         )
       LIMIT 1`
    )
    .get(chatId, userId, chatId, lookbackCount) as
    | { title: string }
    | undefined;

  return row?.title ?? null;
}

// --- Group stats ---

export interface GroupStats {
  totalRaffles: number;
  activeRaffles: number;
  drawnRaffles: number;
  totalEntries: number;
  totalWinners: number;
  uniqueParticipants: number;
  rafflesLast7Days: number;
  entriesLast7Days: number;
  avgEntriesPerRaffle: number;
  topParticipants: Array<{ name: string; count: number }>;
  topWinners: Array<{ name: string; count: number }>;
}

export function getGroupStats(chatId: number): GroupStats {
  const d = getDb();

  const totalRaffles = (
    d.prepare("SELECT COUNT(*) as c FROM raffles WHERE chat_id = ?").get(chatId) as { c: number }
  ).c;
  const activeRaffles = (
    d.prepare("SELECT COUNT(*) as c FROM raffles WHERE chat_id = ? AND status = 'open'").get(chatId) as { c: number }
  ).c;
  const drawnRaffles = (
    d.prepare("SELECT COUNT(*) as c FROM raffles WHERE chat_id = ? AND status = 'drawn'").get(chatId) as { c: number }
  ).c;
  const totalEntries = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffle_entries e JOIN raffles r ON e.raffle_id = r.id WHERE r.chat_id = ?"
    ).get(chatId) as { c: number }
  ).c;
  const totalWinners = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffle_winners w JOIN raffles r ON w.raffle_id = r.id WHERE r.chat_id = ?"
    ).get(chatId) as { c: number }
  ).c;
  const uniqueParticipants = (
    d.prepare(
      "SELECT COUNT(DISTINCT e.user_id) as c FROM raffle_entries e JOIN raffles r ON e.raffle_id = r.id WHERE r.chat_id = ?"
    ).get(chatId) as { c: number }
  ).c;
  const rafflesLast7Days = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffles WHERE chat_id = ? AND created_at >= datetime('now', '-7 days')"
    ).get(chatId) as { c: number }
  ).c;
  const entriesLast7Days = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffle_entries e JOIN raffles r ON e.raffle_id = r.id WHERE r.chat_id = ? AND e.entered_at >= datetime('now', '-7 days')"
    ).get(chatId) as { c: number }
  ).c;

  const avgEntriesPerRaffle = totalRaffles > 0 ? Math.round(totalEntries / totalRaffles) : 0;

  const topParticipants = d
    .prepare(
      `SELECT e.user_display_name as name, COUNT(*) as count
       FROM raffle_entries e JOIN raffles r ON e.raffle_id = r.id
       WHERE r.chat_id = ?
       GROUP BY e.user_id ORDER BY count DESC LIMIT 5`
    )
    .all(chatId) as Array<{ name: string; count: number }>;

  const topWinners = d
    .prepare(
      `SELECT w.user_display_name as name, COUNT(*) as count
       FROM raffle_winners w JOIN raffles r ON w.raffle_id = r.id
       WHERE r.chat_id = ?
       GROUP BY w.user_id ORDER BY count DESC LIMIT 5`
    )
    .all(chatId) as Array<{ name: string; count: number }>;

  return {
    totalRaffles,
    activeRaffles,
    drawnRaffles,
    totalEntries,
    totalWinners,
    uniqueParticipants,
    rafflesLast7Days,
    entriesLast7Days,
    avgEntriesPerRaffle,
    topParticipants,
    topWinners,
  };
}

// --- Data retention / auto-purge ---

/**
 * Purge entry data for completed raffles older than `retentionHours`.
 * Keeps raffle records and winner records intact for history display.
 * Only deletes the raffle_entries rows (the bulk data).
 * Returns the number of raffles whose entries were purged.
 */
export function purgeExpiredData(retentionHours: number): number {
  // Find drawn raffles older than retention period
  const drawnRaffles = getDb()
    .prepare(
      `SELECT id FROM raffles
       WHERE status = 'drawn'
         AND drawn_at IS NOT NULL
         AND drawn_at <= datetime('now', ? || ' hours')`
    )
    .all(`-${retentionHours}`) as Array<{ id: number }>;

  // Find closed (cancelled) raffles older than retention period
  const closedRaffles = getDb()
    .prepare(
      `SELECT id FROM raffles
       WHERE status = 'closed'
         AND created_at <= datetime('now', ? || ' hours')`
    )
    .all(`-${retentionHours}`) as Array<{ id: number }>;

  const raffleIds = [...drawnRaffles, ...closedRaffles].map((r) => r.id);
  if (raffleIds.length === 0) return 0;

  // Delete only entries for these raffles (keep raffle records and winners for history)
  const deleteEntries = getDb().prepare(
    `DELETE FROM raffle_entries WHERE raffle_id = ?`
  );

  const purgeAll = getDb().transaction(() => {
    for (const id of raffleIds) {
      deleteEntries.run(id);
    }
  });

  purgeAll();
  return raffleIds.length;
}

// --- Edit active raffle ---

export function updateRaffleFields(
  raffleId: number,
  fields: Record<string, unknown>
): boolean {
  const allowedFields = [
    "title",
    "prize",
    "prizes",
    "max_entries",
    "max_winners",
    "ends_at",
    "sponsor_name",
    "description",
    "anonymous",
    "auto_pin",
    "min_account_age_days",
    "require_username",
    "winner_cooldown",
    "image_file_id",
    "referral_enabled",
    "max_referral_entries",
    "revoke_referral_links",
  ];
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowedFields.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return false;

  values.push(raffleId);
  const result = getDb()
    .prepare(`UPDATE raffles SET ${updates.join(", ")} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

// --- Chat settings (language) ---

export function getChatLanguage(chatId: number): string {
  const row = getDb()
    .prepare("SELECT language FROM chat_settings WHERE chat_id = ?")
    .get(chatId) as { language: string } | undefined;
  return row?.language || "en";
}

export function setChatLanguage(chatId: number, language: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_settings (chat_id, language) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET language = ?, updated_at = datetime('now')`
    )
    .run(chatId, language, language);
}

export function getSupportedLanguages(): string[] {
  return ["en", "es", "pt", "ru", "fr", "de"];
}

// --- Bot stats ---

export interface BotStats {
  totalGroups: number;
  totalCreators: number;
  totalParticipants: number;
  totalRaffles: number;
  activeRaffles: number;
  drawnRaffles: number;
  totalEntries: number;
  totalWinners: number;
  rafflesLast7Days: number;
  entriesLast7Days: number;
}

export function getBotStats(): BotStats {
  const d = getDb();

  const totalGroups = (d.prepare("SELECT COUNT(DISTINCT chat_id) as c FROM raffles").get() as { c: number }).c;
  const totalCreators = (d.prepare("SELECT COUNT(DISTINCT creator_id) as c FROM raffles").get() as { c: number }).c;
  const totalParticipants = (d.prepare("SELECT COUNT(DISTINCT user_id) as c FROM raffle_entries").get() as { c: number }).c;
  const totalRaffles = (d.prepare("SELECT COUNT(*) as c FROM raffles").get() as { c: number }).c;
  const activeRaffles = (d.prepare("SELECT COUNT(*) as c FROM raffles WHERE status = 'open'").get() as { c: number }).c;
  const drawnRaffles = (d.prepare("SELECT COUNT(*) as c FROM raffles WHERE status = 'drawn'").get() as { c: number }).c;
  const totalEntries = (d.prepare("SELECT COUNT(*) as c FROM raffle_entries").get() as { c: number }).c;
  const totalWinners = (d.prepare("SELECT COUNT(*) as c FROM raffle_winners").get() as { c: number }).c;
  const rafflesLast7Days = (d.prepare("SELECT COUNT(*) as c FROM raffles WHERE created_at >= datetime('now', '-7 days')").get() as { c: number }).c;
  const entriesLast7Days = (d.prepare("SELECT COUNT(*) as c FROM raffle_entries WHERE entered_at >= datetime('now', '-7 days')").get() as { c: number }).c;

  return {
    totalGroups,
    totalCreators,
    totalParticipants,
    totalRaffles,
    activeRaffles,
    drawnRaffles,
    totalEntries,
    totalWinners,
    rafflesLast7Days,
    entriesLast7Days,
  };
}

// --- Group list ---

export function getAllGroupChatIds(): number[] {
  const d = getDb();
  const rows = d.prepare("SELECT DISTINCT chat_id FROM raffles ORDER BY chat_id").all() as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

// --- Active raffles by group ---

export function getActiveRafflesByGroup(): Array<{ chat_id: number; raffles: Raffle[] }> {
  const d = getDb();
  const activeRaffles = d
    .prepare("SELECT * FROM raffles WHERE status = 'open' ORDER BY chat_id, created_at DESC")
    .all() as Raffle[];

  // Group by chat_id
  const grouped = new Map<number, Raffle[]>();
  for (const raffle of activeRaffles) {
    if (!grouped.has(raffle.chat_id)) {
      grouped.set(raffle.chat_id, []);
    }
    grouped.get(raffle.chat_id)!.push(raffle);
  }

  return Array.from(grouped.entries()).map(([chat_id, raffles]) => ({ chat_id, raffles }));
}

// --- Banner cache ---

export function getCachedBannerFileId(bannerType: string): string | null {
  const d = getDb();
  const row = d
    .prepare("SELECT file_id FROM banner_cache WHERE banner_type = ?")
    .get(bannerType) as { file_id: string } | undefined;
  return row?.file_id ?? null;
}

export function setCachedBannerFileId(bannerType: string, fileId: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO banner_cache (banner_type, file_id) VALUES (?, ?)
     ON CONFLICT(banner_type) DO UPDATE SET file_id = ?, updated_at = datetime('now')`
  ).run(bannerType, fileId, fileId);
}

export function clearBannerCache(): void {
  const d = getDb();
  d.prepare("DELETE FROM banner_cache").run();
  console.log("Banner cache cleared");
}

// --- Referral links ---

export function createReferralLink(
  raffleId: number,
  userId: number,
  displayName: string,
  chatId: number,
  inviteLink: string
): ReferralLink {
  const stmt = getDb().prepare(`
    INSERT INTO referral_links (raffle_id, user_id, user_display_name, chat_id, invite_link)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(raffleId, userId, displayName, chatId, inviteLink);
  return getDb()
    .prepare("SELECT * FROM referral_links WHERE id = ?")
    .get(result.lastInsertRowid) as ReferralLink;
}

export function getReferralLink(
  raffleId: number,
  userId: number
): ReferralLink | undefined {
  return getDb()
    .prepare("SELECT * FROM referral_links WHERE raffle_id = ? AND user_id = ?")
    .get(raffleId, userId) as ReferralLink | undefined;
}

export function getReferralByInviteLink(
  inviteLink: string
): ReferralLink | undefined {
  return getDb()
    .prepare("SELECT * FROM referral_links WHERE invite_link = ?")
    .get(inviteLink) as ReferralLink | undefined;
}

/**
 * Find all active referral links for a chat (across all open raffles).
 * Used when a new member joins via invite link to match the referrer.
 */
export function getActiveReferralsByInviteLink(
  inviteLink: string
): ReferralLink[] {
  return getDb()
    .prepare(
      `SELECT rl.* FROM referral_links rl
       JOIN raffles r ON rl.raffle_id = r.id
       WHERE rl.invite_link = ? AND r.status = 'open'`
    )
    .all(inviteLink) as ReferralLink[];
}

export function incrementBonusEntries(referralId: number): void {
  getDb()
    .prepare("UPDATE referral_links SET bonus_entries = bonus_entries + 1 WHERE id = ?")
    .run(referralId);
}

export function getBonusEntries(raffleId: number, userId: number): number {
  const row = getDb()
    .prepare("SELECT bonus_entries FROM referral_links WHERE raffle_id = ? AND user_id = ?")
    .get(raffleId, userId) as { bonus_entries: number } | undefined;
  return row?.bonus_entries ?? 0;
}

export function getReferralLinksForRaffle(raffleId: number): ReferralLink[] {
  return getDb()
    .prepare("SELECT * FROM referral_links WHERE raffle_id = ? ORDER BY bonus_entries DESC")
    .all(raffleId) as ReferralLink[];
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
