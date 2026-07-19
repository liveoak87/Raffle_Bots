import Database from "better-sqlite3";
import { randomInt } from "crypto";
import type {
  Raffle,
  RaffleEntry,
  RaffleWinner,
  CreateRaffleInput,
  RaffleTemplate,
  GroupDefaults,
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
      thread_id INTEGER,
      creator_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prize TEXT NOT NULL,
      prizes TEXT,
      max_entries INTEGER,
      max_winners INTEGER NOT NULL DEFAULT 1,
      duration_minutes INTEGER,
      starts_after_minutes INTEGER,
      display_timezone TEXT,
      required_chat_id INTEGER,
      required_chat_title TEXT,
      sponsor_name TEXT,
      anonymous INTEGER NOT NULL DEFAULT 0,
      image_file_id TEXT,
      auto_pin INTEGER NOT NULL DEFAULT 0,
      min_account_age_days INTEGER NOT NULL DEFAULT 0,
      require_username INTEGER NOT NULL DEFAULT 0,
      winner_cooldown INTEGER NOT NULL DEFAULT 0,
      show_animation INTEGER NOT NULL DEFAULT 1,
      referral_enabled INTEGER NOT NULL DEFAULT 0,
      max_referral_entries INTEGER NOT NULL DEFAULT 0,
      revoke_referral_links INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS bot_groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      bot_status TEXT NOT NULL DEFAULT 'member' CHECK(bot_status IN ('member', 'administrator')),
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_defaults (
      chat_id INTEGER PRIMARY KEY,
      max_entries INTEGER,
      max_winners INTEGER,
      duration_minutes INTEGER,
      sponsor_name TEXT,
      anonymous INTEGER,
      auto_pin INTEGER,
      min_account_age_days INTEGER,
      require_username INTEGER,
      winner_cooldown INTEGER,
      show_animation INTEGER,
      referral_enabled INTEGER,
      max_referral_entries INTEGER,
      revoke_referral_links INTEGER,
      required_chat_id INTEGER,
      required_chat_title TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_admin_groups (
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      admin_role TEXT NOT NULL DEFAULT 'administrator' CHECK(admin_role IN ('administrator', 'creator')),
      verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS group_access_settings (
      chat_id INTEGER PRIMARY KEY,
      access_mode TEXT NOT NULL DEFAULT 'all_admins' CHECK(access_mode IN ('all_admins', 'owner_only', 'selected_admins')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_access_admins (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      added_by INTEGER NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_raffles_chat_id ON raffles(chat_id);
    CREATE INDEX IF NOT EXISTS idx_raffles_status ON raffles(status);
    CREATE INDEX IF NOT EXISTS idx_raffles_status_ends ON raffles(status, ends_at);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_raffle_id ON raffle_entries(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_recent ON raffle_entries(raffle_id, entered_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_user_id ON raffle_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_raffle_winners_raffle_id ON raffle_winners(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_templates_chat_id ON raffle_templates(chat_id);
    CREATE INDEX IF NOT EXISTS idx_templates_recurring_due ON raffle_templates(recurring_active, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_referral_links_invite ON referral_links(invite_link);
    CREATE INDEX IF NOT EXISTS idx_referral_links_raffle ON referral_links(raffle_id);
    CREATE INDEX IF NOT EXISTS idx_user_admin_groups_user ON user_admin_groups(user_id);
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
  const botGroupsColumns = tableInfo("bot_groups").map((c) => c.name);
  const userAdminGroupColumns = tableInfo("user_admin_groups").map((c) => c.name);

  if (!botGroupsColumns.includes("timezone")) {
    getDb().exec("ALTER TABLE bot_groups ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
  }
  if (!userAdminGroupColumns.includes("admin_role")) {
    getDb().exec(
      "ALTER TABLE user_admin_groups ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'administrator'"
    );
  }

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

  if (!raffleColumns.includes("announced")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN announced INTEGER NOT NULL DEFAULT 0"
    );
    // Mark all existing drawn raffles as announced (they predate this feature)
    getDb().exec("UPDATE raffles SET announced = 1 WHERE status = 'drawn'");
  }

  if (!raffleColumns.includes("announce_attempts")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN announce_attempts INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("last_announce_at")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN last_announce_at TEXT DEFAULT NULL");
  }
  if (!raffleColumns.includes("announce_failed")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN announce_failed INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!raffleColumns.includes("owner_alerted")) {
    getDb().exec(
      "ALTER TABLE raffles ADD COLUMN owner_alerted INTEGER NOT NULL DEFAULT 0"
    );
  }

  if (!raffleColumns.includes("thread_id")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN thread_id INTEGER DEFAULT NULL");
  }

  if (!raffleColumns.includes("display_timezone")) {
    getDb().exec("ALTER TABLE raffles ADD COLUMN display_timezone TEXT DEFAULT NULL");
  }

  // Add current template/default columns to existing databases.
  try {
    const templateColumns = tableInfo("raffle_templates").map((c) => c.name);
    const addTemplateColumn = (name: string, ddl: string) => {
      if (!templateColumns.includes(name)) getDb().exec(ddl);
    };
    addTemplateColumn("thread_id", "ALTER TABLE raffle_templates ADD COLUMN thread_id INTEGER DEFAULT NULL");
    addTemplateColumn("description", "ALTER TABLE raffle_templates ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    addTemplateColumn("starts_after_minutes", "ALTER TABLE raffle_templates ADD COLUMN starts_after_minutes INTEGER DEFAULT NULL");
    addTemplateColumn("display_timezone", "ALTER TABLE raffle_templates ADD COLUMN display_timezone TEXT DEFAULT NULL");
    addTemplateColumn("required_chat_id", "ALTER TABLE raffle_templates ADD COLUMN required_chat_id INTEGER DEFAULT NULL");
    addTemplateColumn("required_chat_title", "ALTER TABLE raffle_templates ADD COLUMN required_chat_title TEXT DEFAULT NULL");
    addTemplateColumn("image_file_id", "ALTER TABLE raffle_templates ADD COLUMN image_file_id TEXT DEFAULT NULL");
    addTemplateColumn("auto_pin", "ALTER TABLE raffle_templates ADD COLUMN auto_pin INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("min_account_age_days", "ALTER TABLE raffle_templates ADD COLUMN min_account_age_days INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("require_username", "ALTER TABLE raffle_templates ADD COLUMN require_username INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("winner_cooldown", "ALTER TABLE raffle_templates ADD COLUMN winner_cooldown INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("show_animation", "ALTER TABLE raffle_templates ADD COLUMN show_animation INTEGER NOT NULL DEFAULT 1");
    addTemplateColumn("referral_enabled", "ALTER TABLE raffle_templates ADD COLUMN referral_enabled INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("max_referral_entries", "ALTER TABLE raffle_templates ADD COLUMN max_referral_entries INTEGER NOT NULL DEFAULT 0");
    addTemplateColumn("revoke_referral_links", "ALTER TABLE raffle_templates ADD COLUMN revoke_referral_links INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Table may not exist yet
  }

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS group_defaults (
      chat_id INTEGER PRIMARY KEY,
      max_entries INTEGER,
      max_winners INTEGER,
      duration_minutes INTEGER,
      sponsor_name TEXT,
      anonymous INTEGER,
      auto_pin INTEGER,
      min_account_age_days INTEGER,
      require_username INTEGER,
      winner_cooldown INTEGER,
      show_animation INTEGER,
      referral_enabled INTEGER,
      max_referral_entries INTEGER,
      revoke_referral_links INTEGER,
      required_chat_id INTEGER,
      required_chat_title TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Create persistent job queue table — survives bot restarts.
  // Used for fire-and-forget background tasks (winner DMs, banner ops, etc.)
  // that must complete even if the process dies mid-task.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_error TEXT,
      run_after TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
  `);

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

  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_raffle_entries_recent ON raffle_entries(raffle_id, entered_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_templates_recurring_due ON raffle_templates(recurring_active, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_raffles_announcement_retry
      ON raffles(status, announced, announce_failed, owner_alerted, drawn_at);
    CREATE INDEX IF NOT EXISTS idx_raffles_created_at ON raffles(created_at);
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
    INSERT INTO raffles (chat_id, thread_id, creator_id, creator_name, title, description, prize, prizes, max_entries, max_winners, ends_at, starts_at, display_timezone, required_chat_id, required_chat_title, sponsor_name, anonymous, image_file_id, auto_pin, min_account_age_days, require_username, winner_cooldown, show_animation, referral_enabled, max_referral_entries, revoke_referral_links)
    VALUES (@chat_id, @thread_id, @creator_id, @creator_name, @title, @description, @prize, @prizes, @max_entries, @max_winners, @ends_at, @starts_at, @display_timezone, @required_chat_id, @required_chat_title, @sponsor_name, @anonymous, @image_file_id, @auto_pin, @min_account_age_days, @require_username, @winner_cooldown, @show_animation, @referral_enabled, @max_referral_entries, @revoke_referral_links)
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

export function getOpenRafflesEnteredByUser(userId: number): Raffle[] {
  return getDb()
    .prepare(
      `SELECT r.*
       FROM raffles r
       JOIN raffle_entries e ON e.raffle_id = r.id
       WHERE e.user_id = ? AND r.status = 'open'
       ORDER BY r.created_at DESC`
    )
    .all(userId) as Raffle[];
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

/**
 * Recent raffles created by a specific user across ALL chats — used when
 * someone runs /exportentries in DM (no chat context available).
 */
export function getRecentRafflesByCreator(
  userId: number,
  limit: number = 20
): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, limit) as Raffle[];
}

export function getRafflesCreatedSince(sinceUtc: string): Raffle[] {
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE created_at >= ? ORDER BY created_at ASC"
    )
    .all(sinceUtc) as Raffle[];
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

export function markRaffleAnnounced(raffleId: number): void {
  getDb()
    .prepare("UPDATE raffles SET announced = 1 WHERE id = ?")
    .run(raffleId);
}

export function getUnannouncedDrawnRaffles(): Raffle[] {
  // Don't include raffles already marked as permanently failed
  return getDb()
    .prepare(
      "SELECT * FROM raffles WHERE status = 'drawn' AND announced = 0 AND announce_failed = 0"
    )
    .all() as Raffle[];
}

export function recordAnnounceAttempt(raffleId: number): void {
  getDb()
    .prepare(
      "UPDATE raffles SET announce_attempts = announce_attempts + 1, last_announce_at = datetime('now') WHERE id = ?"
    )
    .run(raffleId);
}

export function markAnnounceFailed(raffleId: number): void {
  getDb()
    .prepare("UPDATE raffles SET announce_failed = 1 WHERE id = ?")
    .run(raffleId);
}

export function markOwnerAlerted(raffleId: number): void {
  getDb()
    .prepare("UPDATE raffles SET owner_alerted = 1 WHERE id = ?")
    .run(raffleId);
}

/** Raffles stuck unannounced for at least N minutes that the owner hasn't been alerted about. */
export function getStuckUnnotifiedRaffles(minutesThreshold: number): Raffle[] {
  return getDb()
    .prepare(
      `SELECT * FROM raffles
       WHERE status = 'drawn'
         AND announced = 0
         AND announce_failed = 0
         AND owner_alerted = 0
         AND drawn_at <= datetime('now', '-' || ? || ' minutes')`
    )
    .all(minutesThreshold) as Raffle[];
}

/** Raffles that have been retried for >X hours — give up. */
export function getRafflesToGiveUpOn(hoursThreshold: number): Raffle[] {
  return getDb()
    .prepare(
      `SELECT * FROM raffles
       WHERE status = 'drawn'
         AND announced = 0
         AND announce_failed = 0
         AND drawn_at <= datetime('now', '-' || ? || ' hours')`
    )
    .all(hoursThreshold) as Raffle[];
}

/** Count raffles in a chat that are active (open) or have unannounced wins. Used when bot is kicked. */
export function countActiveOrUnannouncedInChat(chatId: number): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) as c FROM raffles WHERE chat_id = ? AND (status = 'open' OR (status = 'drawn' AND announced = 0))"
      )
      .get(chatId) as { c: number }
  ).c;
}

/** Get up to N oldest unannounced raffles for /health "worst stuck" report. */
export function getOldestUnannouncedRaffles(limit: number): Array<{
  id: number;
  title: string;
  chat_id: number;
  drawn_at: string;
  announce_attempts: number;
}> {
  return getDb()
    .prepare(
      `SELECT id, title, chat_id, drawn_at, announce_attempts
       FROM raffles
       WHERE status = 'drawn' AND announced = 0 AND announce_failed = 0
       ORDER BY drawn_at ASC
       LIMIT ?`
    )
    .all(limit) as Array<{
      id: number;
      title: string;
      chat_id: number;
      drawn_at: string;
      announce_attempts: number;
    }>;
}

/** Counts of currently stuck raffles for /health command. */
export function getAnnouncementHealth(): {
  totalUnannounced: number;
  stuckOver15min: number;
  stuckOver1h: number;
  permanentlyFailed: number;
} {
  const d = getDb();
  const totalUnannounced = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffles WHERE status='drawn' AND announced=0 AND announce_failed=0"
    ).get() as { c: number }
  ).c;
  const stuckOver15min = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffles WHERE status='drawn' AND announced=0 AND announce_failed=0 AND drawn_at <= datetime('now', '-15 minutes')"
    ).get() as { c: number }
  ).c;
  const stuckOver1h = (
    d.prepare(
      "SELECT COUNT(*) as c FROM raffles WHERE status='drawn' AND announced=0 AND announce_failed=0 AND drawn_at <= datetime('now', '-1 hours')"
    ).get() as { c: number }
  ).c;
  const permanentlyFailed = (
    d.prepare("SELECT COUNT(*) as c FROM raffles WHERE announce_failed=1").get() as { c: number }
  ).c;
  return { totalUnannounced, stuckOver15min, stuckOver1h, permanentlyFailed };
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

export interface RecentRaffleEntry extends RaffleEntry {
  bonus_entries: number;
}

export function getRecentEntriesForRaffle(
  raffleId: number,
  limit: number
): RecentRaffleEntry[] {
  return getDb()
    .prepare(
      `SELECT e.*, COALESCE(rl.bonus_entries, 0) as bonus_entries
       FROM raffle_entries e
       LEFT JOIN referral_links rl
         ON rl.raffle_id = e.raffle_id
        AND rl.user_id = e.user_id
       WHERE e.raffle_id = ?
       ORDER BY e.entered_at DESC, e.id DESC
       LIMIT ?`
    )
    .all(raffleId, limit) as RecentRaffleEntry[];
}

interface WeightedRaffleEntry extends RaffleEntry {
  bonus_entries: number;
}

function getEntriesWithBonusForRaffle(raffleId: number): WeightedRaffleEntry[] {
  return getDb()
    .prepare(
      `SELECT e.*, COALESCE(rl.bonus_entries, 0) as bonus_entries
       FROM raffle_entries e
       LEFT JOIN referral_links rl
         ON rl.raffle_id = e.raffle_id
        AND rl.user_id = e.user_id
       WHERE e.raffle_id = ?
       ORDER BY e.entered_at ASC`
    )
    .all(raffleId) as WeightedRaffleEntry[];
}

export function getEntryCount(raffleId: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM raffle_entries WHERE raffle_id = ?"
    )
    .get(raffleId) as { count: number };
  return row.count;
}

/** Get total entries including referral bonus entries (for display purposes) */
export function getTotalEntryCount(raffleId: number): number {
  const baseCount = getEntryCount(raffleId);
  const raffle = getRaffleById(raffleId);
  if (!raffle || !raffle.referral_enabled) return baseCount;
  const bonusRow = getDb()
    .prepare(
      "SELECT COALESCE(SUM(bonus_entries), 0) as total FROM referral_links WHERE raffle_id = ?"
    )
    .get(raffleId) as { total: number };
  return baseCount + bonusRow.total;
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

  let selected: RaffleEntry[];
  if (raffle.referral_enabled) {
    selected = selectWeightedWinners(
      getEntriesWithBonusForRaffle(raffleId),
      numWinners
    );
  } else {
    selected = cryptoShuffle(entries).slice(0, numWinners);
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
  thread_id: number | null;
  creator_id: number;
  name: string;
  title: string;
  description?: string;
  prize: string;
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  duration_minutes: number | null;
  starts_after_minutes?: number | null;
  display_timezone?: string | null;
  required_chat_id?: number | null;
  required_chat_title?: string | null;
  sponsor_name: string | null;
  anonymous: number;
  image_file_id?: string | null;
  auto_pin?: number;
  min_account_age_days?: number;
  require_username?: number;
  winner_cooldown?: number;
  show_animation?: number;
  referral_enabled?: number;
  max_referral_entries?: number;
  revoke_referral_links?: number;
  recurring_interval_minutes: number | null;
}): RaffleTemplate {
  const values = {
    description: "",
    starts_after_minutes: null,
    display_timezone: null,
    required_chat_id: null,
    required_chat_title: null,
    image_file_id: null,
    auto_pin: 0,
    min_account_age_days: 0,
    require_username: 0,
    winner_cooldown: 0,
    show_animation: 1,
    referral_enabled: 0,
    max_referral_entries: 0,
    revoke_referral_links: 0,
    ...input,
  };
  const stmt = getDb().prepare(`
    INSERT INTO raffle_templates (
      chat_id, thread_id, creator_id, name, title, description, prize, prizes,
      max_entries, max_winners, duration_minutes, starts_after_minutes,
      display_timezone, required_chat_id, required_chat_title, sponsor_name,
      anonymous, image_file_id, auto_pin, min_account_age_days, require_username,
      winner_cooldown, show_animation, referral_enabled, max_referral_entries,
      revoke_referral_links, recurring_interval_minutes, recurring_active, next_run_at
    )
    VALUES (
      @chat_id, @thread_id, @creator_id, @name, @title, @description, @prize, @prizes,
      @max_entries, @max_winners, @duration_minutes, @starts_after_minutes,
      @display_timezone, @required_chat_id, @required_chat_title, @sponsor_name,
      @anonymous, @image_file_id, @auto_pin, @min_account_age_days, @require_username,
      @winner_cooldown, @show_animation, @referral_enabled, @max_referral_entries,
      @revoke_referral_links, @recurring_interval_minutes, 0, NULL
    )
  `);
  const result = stmt.run(values);
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

export function claimDueRecurringTemplates(): RaffleTemplate[] {
  const d = getDb();
  const claimAll = d.transaction(() => {
    const due = d
      .prepare(
        `SELECT * FROM raffle_templates
         WHERE recurring_active = 1
           AND recurring_interval_minutes IS NOT NULL
           AND next_run_at IS NOT NULL
           AND next_run_at <= datetime('now')
         ORDER BY next_run_at ASC, id ASC`
      )
      .all() as RaffleTemplate[];

    const update = d.prepare(
      `UPDATE raffle_templates
       SET next_run_at = ?
       WHERE id = ?
         AND recurring_active = 1
         AND next_run_at = ?
         AND next_run_at <= datetime('now')`
    );

    const claimed: RaffleTemplate[] = [];
    for (const template of due) {
      if (!template.recurring_interval_minutes || !template.next_run_at) continue;
      const nextRun = new Date(
        Date.now() + template.recurring_interval_minutes * 60 * 1000
      );
      const nextRunStr = formatSqlDate(nextRun);
      const result = update.run(nextRunStr, template.id, template.next_run_at);
      if (result.changes === 1) {
        claimed.push({ ...template, next_run_at: nextRunStr });
      }
    }
    return claimed;
  });

  return claimAll();
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
    "description",
    "prize",
    "prizes",
    "max_entries",
    "max_winners",
    "ends_at",
    "starts_at",
    "sponsor_name",
    "anonymous",
    "auto_pin",
    "min_account_age_days",
    "require_username",
    "winner_cooldown",
    "show_animation",
    "image_file_id",
    "required_chat_id",
    "required_chat_title",
    "referral_enabled",
    "max_referral_entries",
    "revoke_referral_links",
    "thread_id",
    "display_timezone",
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

// --- Group defaults ---

export function getGroupDefaults(chatId: number): GroupDefaults | undefined {
  return getDb()
    .prepare("SELECT * FROM group_defaults WHERE chat_id = ?")
    .get(chatId) as GroupDefaults | undefined;
}

export function upsertGroupDefaults(
  chatId: number,
  fields: Partial<Omit<GroupDefaults, "chat_id" | "updated_at">>
): void {
  const existing = getGroupDefaults(chatId);
  const defaults: Omit<GroupDefaults, "updated_at"> = {
    chat_id: chatId,
    max_entries: null,
    max_winners: null,
    duration_minutes: null,
    sponsor_name: null,
    anonymous: null,
    auto_pin: null,
    min_account_age_days: null,
    require_username: null,
    winner_cooldown: null,
    show_animation: null,
    referral_enabled: null,
    max_referral_entries: null,
    revoke_referral_links: null,
    required_chat_id: null,
    required_chat_title: null,
    ...(existing || {}),
    ...fields,
  };

  getDb()
    .prepare(
      `INSERT INTO group_defaults (
        chat_id, max_entries, max_winners, duration_minutes, sponsor_name,
        anonymous, auto_pin, min_account_age_days, require_username,
        winner_cooldown, show_animation, referral_enabled, max_referral_entries,
        revoke_referral_links, required_chat_id, required_chat_title, updated_at
      )
      VALUES (
        @chat_id, @max_entries, @max_winners, @duration_minutes, @sponsor_name,
        @anonymous, @auto_pin, @min_account_age_days, @require_username,
        @winner_cooldown, @show_animation, @referral_enabled, @max_referral_entries,
        @revoke_referral_links, @required_chat_id, @required_chat_title, datetime('now')
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        max_entries = excluded.max_entries,
        max_winners = excluded.max_winners,
        duration_minutes = excluded.duration_minutes,
        sponsor_name = excluded.sponsor_name,
        anonymous = excluded.anonymous,
        auto_pin = excluded.auto_pin,
        min_account_age_days = excluded.min_account_age_days,
        require_username = excluded.require_username,
        winner_cooldown = excluded.winner_cooldown,
        show_animation = excluded.show_animation,
        referral_enabled = excluded.referral_enabled,
        max_referral_entries = excluded.max_referral_entries,
        revoke_referral_links = excluded.revoke_referral_links,
        required_chat_id = excluded.required_chat_id,
        required_chat_title = excluded.required_chat_title,
        updated_at = datetime('now')`
    )
    .run(defaults);
}

export function clearGroupDefaults(chatId: number): void {
  getDb().prepare("DELETE FROM group_defaults WHERE chat_id = ?").run(chatId);
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

// --- Group list (legacy — from raffle history) ---

export function getAllGroupChatIds(): number[] {
  const d = getDb();
  const rows = d.prepare("SELECT DISTINCT chat_id FROM raffles ORDER BY chat_id").all() as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

// --- Bot group tracking ---

export interface BotGroup {
  chat_id: number;
  title: string;
  bot_status: "member" | "administrator";
  /** IANA timezone (e.g. "America/New_York"). Defaults to "UTC". */
  timezone: string;
  added_at: string;
  updated_at: string;
}

export function upsertBotGroup(chatId: number, title: string, botStatus: "member" | "administrator"): void {
  getDb()
    .prepare(
      `INSERT INTO bot_groups (chat_id, title, bot_status, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET
         title = excluded.title,
         bot_status = excluded.bot_status,
         updated_at = datetime('now')`
    )
    .run(chatId, title, botStatus);
}

export function getBotGroup(chatId: number): BotGroup | undefined {
  return getDb()
    .prepare("SELECT * FROM bot_groups WHERE chat_id = ?")
    .get(chatId) as BotGroup | undefined;
}

export function removeBotGroup(chatId: number): void {
  getDb().prepare("DELETE FROM bot_groups WHERE chat_id = ?").run(chatId);
}

export function getActiveBotGroups(): BotGroup[] {
  return getDb()
    .prepare("SELECT * FROM bot_groups ORDER BY title COLLATE NOCASE")
    .all() as BotGroup[];
}

export function getAdminBotGroups(): BotGroup[] {
  return getDb()
    .prepare("SELECT * FROM bot_groups WHERE bot_status = 'administrator' ORDER BY title COLLATE NOCASE")
    .all() as BotGroup[];
}

export type GroupAccessMode = "all_admins" | "owner_only" | "selected_admins";

export interface UserAdminGroup extends BotGroup {
  admin_role: "administrator" | "creator";
}

export function rememberUserAdminGroup(
  userId: number,
  chatId: number,
  role: "administrator" | "creator" = "administrator"
): void {
  getDb()
    .prepare(
      `INSERT INTO user_admin_groups (user_id, chat_id, admin_role, verified_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, chat_id) DO UPDATE SET
         admin_role = excluded.admin_role,
         verified_at = datetime('now')`
    )
    .run(userId, chatId, role);
}

export function forgetUserAdminGroup(userId: number, chatId: number): void {
  getDb()
    .prepare("DELETE FROM user_admin_groups WHERE user_id = ? AND chat_id = ?")
    .run(userId, chatId);
}

export function clearUserAdminGroups(userId: number): void {
  getDb().prepare("DELETE FROM user_admin_groups WHERE user_id = ?").run(userId);
}

export function getUserAdminGroups(userId: number): UserAdminGroup[] {
  return getDb()
    .prepare(
      `SELECT bg.*, uag.admin_role
       FROM user_admin_groups uag
       JOIN bot_groups bg ON bg.chat_id = uag.chat_id
       LEFT JOIN group_access_settings gas ON gas.chat_id = bg.chat_id
       WHERE uag.user_id = ?
         AND (
           uag.admin_role = 'creator'
           OR COALESCE(gas.access_mode, 'all_admins') = 'all_admins'
           OR (
             gas.access_mode = 'selected_admins'
             AND EXISTS (
               SELECT 1 FROM group_access_admins gaa
               WHERE gaa.chat_id = bg.chat_id AND gaa.user_id = uag.user_id
             )
           )
         )
       ORDER BY bg.title COLLATE NOCASE`
    )
    .all(userId) as UserAdminGroup[];
}

export function getGroupAccessMode(chatId: number): GroupAccessMode {
  const row = getDb()
    .prepare("SELECT access_mode FROM group_access_settings WHERE chat_id = ?")
    .get(chatId) as { access_mode: GroupAccessMode } | undefined;
  return row?.access_mode || "all_admins";
}

export function setGroupAccessMode(chatId: number, mode: GroupAccessMode): void {
  getDb()
    .prepare(
      `INSERT INTO group_access_settings (chat_id, access_mode, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET
         access_mode = excluded.access_mode,
         updated_at = datetime('now')`
    )
    .run(chatId, mode);
}

export function getSelectedGroupAdminIds(chatId: number): number[] {
  const rows = getDb()
    .prepare("SELECT user_id FROM group_access_admins WHERE chat_id = ? ORDER BY user_id")
    .all(chatId) as Array<{ user_id: number }>;
  return rows.map((row) => row.user_id);
}

export function isSelectedGroupAdmin(chatId: number, userId: number): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM group_access_admins WHERE chat_id = ? AND user_id = ?")
      .get(chatId, userId)
  );
}

export function setSelectedGroupAdmin(
  chatId: number,
  userId: number,
  allowed: boolean,
  addedBy: number
): void {
  if (!allowed) {
    getDb()
      .prepare("DELETE FROM group_access_admins WHERE chat_id = ? AND user_id = ?")
      .run(chatId, userId);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO group_access_admins (chat_id, user_id, added_by)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET added_by = excluded.added_by`
    )
    .run(chatId, userId, addedBy);
}

/**
 * Return the chat's configured IANA timezone (e.g. "America/New_York").
 * Defaults to "UTC" if the chat is unknown or hasn't been configured.
 */
export function getChatTimezone(chatId: number): string {
  const row = getDb()
    .prepare("SELECT timezone FROM bot_groups WHERE chat_id = ?")
    .get(chatId) as { timezone: string } | undefined;
  return row?.timezone || "UTC";
}

export function setChatTimezone(chatId: number, timezone: string): void {
  // Ensure the row exists first — chat may not have been auto-tracked yet
  getDb()
    .prepare(
      `INSERT INTO bot_groups (chat_id, title, bot_status, timezone)
       VALUES (?, '', 'member', ?)
       ON CONFLICT(chat_id) DO UPDATE SET timezone = excluded.timezone, updated_at = datetime('now')`
    )
    .run(chatId, timezone);
}

export function findOpenRaffleByTitle(title: string): Raffle | null {
  return getDb()
    .prepare("SELECT * FROM raffles WHERE title = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
    .get(title) as Raffle | null;
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
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function selectWeightedWinners(
  entries: WeightedRaffleEntry[],
  numWinners: number
): RaffleEntry[] {
  const candidates = entries.map((entry) => ({
    entry,
    weight: Math.max(1, 1 + entry.bonus_entries),
  }));
  const selected: RaffleEntry[] = [];

  while (selected.length < numWinners) {
    const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (totalWeight <= 0) break;

    let pick = randomInt(totalWeight);
    for (const candidate of candidates) {
      if (candidate.weight === 0) continue;
      if (pick < candidate.weight) {
        selected.push(candidate.entry);
        candidate.weight = 0;
        break;
      }
      pick -= candidate.weight;
    }
  }

  return selected;
}

function formatSqlDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
}
