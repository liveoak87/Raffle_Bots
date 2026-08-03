import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { run, sequentialize } from "@grammyjs/runner";
import { initDatabase } from "./database";
import * as db from "./database";
import { logger } from "./logger";
import { startAdminServer } from "./adminServer";
import { startHeartbeat } from "./heartbeat";
import { metrics } from "./metrics";
import {
  enqueue,
  processJobs,
  registerHandler,
  recoverOrphanedJobs,
  purgeOldJobs,
  getJobStats,
} from "./jobs";
import {
  handleStart,
  handleHelp,
  handleManage,
  handleHomeCallback,
  handleAdminCallback,
  handleAccessCallback,
  handleNewRaffle,
  handleSetRaffleTopic,
  handleListRaffles,
  handleDraw,
  handleDrawCallback,
  handleCancelRaffle,
  handleCancelCallback,
  handleRepostCallback,
  handleMyEntries,
  handleRaffleHistory,
  handleExportEntries,
  handleExportCallback,
  handleRerun,
  handleRerunCallback,
  handleEnterCallback,
  handleLeaveCallback,
  handleEntriesCallback,
  handleSaveTemplate,
  handleTemplates,
  handleDeleteTemplate,
  handleUseTemplate,
  handleRecurring,
  handleTemplateCallback,
  handleEditRaffle,
  handleLanguage,
  handleLanguageCallback,
  handleStats,
  handleHealth,
  handleMetrics,
  handleActive,
  handleTimezone,
  handleTimezoneCallback,
  handleReferralStats,
  handleGroupStats,
  handleDefaults,
  handleDefaultsCallback,
  handleSetupCheck,
  handleReferrals,
  handleReferralsCallback,
  handleBugReport,
  notifyWinnersAndCreator,
  revokeReferralInviteLinks,
  buildStatsMessage,
} from "./commands";
import {
  formatRaffleMessage,
  formatWinnersMessage,
  escapeHtml,
  getUserDisplayName,
  buildMessageLink,
  buildRaffleKeyboard,
} from "./helpers";
import type { Raffle } from "./types";
import { t } from "./i18n";
import { encodeRerunDestination } from "./rerun";
import { handleRecurringPostFailure } from "./recurring";
import { resolveTemplateThreadId } from "./forumTopics";
import { rememberForumTopicFromMessage } from "./topicCache";
import {
  handleWizardMessage,
  handleWizardPhoto,
  handleWinnersCallback,
  handleWinnersCustomCallback,
  handleTimeCallback,
  handleOptionsCallback,
  handleSchedPickerCallback,
  handleCalendarPickerCallback,
  handleStandaloneTzCallback,
  handleStartDeepLink,
  getActiveWizard,
  handleEditCallback,
  handleEditTextMessage,
  handleEditPhotoMessage,
  getActiveEditWizard,
  startEditWizard,
  getActiveTemplateWizard,
  handleTemplateWizardMessage,
  handleTemplateWizardPhoto,
  handleTmplWinnersCallback,
  handleTmplWinnersCustomCallback,
  handleTmplTimeCallback,
  handleTmplOptionsCallback,
  getActiveBugReport,
  handleBugReportMessage,
  handleBugReportPhoto,
  handleBugReportSkip,
  startWizard,
} from "./wizard";
import { sendWheelSpin, sendRafflePost, getBannerFileId, sendWinnerPost } from "./banners";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Error: BOT_TOKEN environment variable is required.");
  console.error("Get a token from @BotFather on Telegram and set it in .env");
  process.exit(1);
}

const DB_PATH = process.env.DATABASE_PATH || "./raffle.db";

// Data retention: hours to keep completed raffle data (0 = keep forever)
const DATA_RETENTION_HOURS = parseInt(
  process.env.DATA_RETENTION_HOURS || "0",
  10
);

// Initialize database
initDatabase(DB_PATH);
console.log(`Database initialized at ${DB_PATH}`);

// Clear banner cache on startup to ensure fresh banners are used
db.clearBannerCache();
if (DATA_RETENTION_HOURS > 0) {
  console.log(
    `Data retention: completed raffle data will be purged after ${DATA_RETENTION_HOURS} hours`
  );
} else {
  console.log(`Data retention: disabled (data kept indefinitely)`);
}

// Create bot
const bot = new Bot(BOT_TOKEN);

// Auto-retry on rate limits (429) with exponential backoff.
// Telegram regularly returns 30-60s waits on bursts, so we let retries wait that long.
bot.api.config.use(autoRetry({
  maxRetryAttempts: 3,
  maxDelaySeconds: 90,
}));

// --- Per-chat outbound throttle (P1 load protection) ---
// Telegram's true sustained limit per group chat is ~1 message/second.
// At 50+ active raffles per chat (announced, ChiTown-style load), countdown
// refreshes alone would burst past this. This transformer queues outbound
// API calls per chat so they never exceed CHAT_API_MIN_INTERVAL_MS apart.
const CHAT_API_MIN_INTERVAL_MS = 1100; // 1.1s — safely under Telegram's 1/sec
const chatApiQueues = new Map<number, Promise<void>>();
const lastChatApiSendAt = new Map<number, number>();

async function chatApiThrottle(chatId: number): Promise<void> {
  const previous = chatApiQueues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const last = lastChatApiSendAt.get(chatId);
      if (last !== undefined) {
        const elapsed = Date.now() - last;
        if (elapsed < CHAT_API_MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, CHAT_API_MIN_INTERVAL_MS - elapsed));
        }
      }
      lastChatApiSendAt.set(chatId, Date.now());
    });
  chatApiQueues.set(chatId, next);
  return next;
}

// Periodic cleanup of stale chat throttle entries
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000; // 10 min idle
  for (const [chatId, t] of lastChatApiSendAt) {
    if (t < cutoff) {
      lastChatApiSendAt.delete(chatId);
      chatApiQueues.delete(chatId);
    }
  }
}, 5 * 60_000);

// Methods that target a specific chat — throttle per-chat
const CHAT_TARGETED_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendAnimation",
  "sendVideo",
  "sendDocument",
  "sendSticker",
  "sendChatAction",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageMedia",
  "deleteMessage",
  "pinChatMessage",
  "unpinChatMessage",
  "sendDice",
  "sendPoll",
]);

bot.api.config.use(async (prev, method, payload, signal) => {
  // Throttle per-chat for chat-targeted methods, except for the owner's DM
  // (DMs with the owner are low-volume and shouldn't be throttled).
  if (CHAT_TARGETED_METHODS.has(method)) {
    const chatId = (payload as { chat_id?: number | string }).chat_id;
    if (typeof chatId === "number" && chatId < 0) {
      // Negative chat IDs = groups/supergroups (where rate limits bite)
      await chatApiThrottle(chatId);
    }
  }
  return prev(method, payload, signal);
});

// Metrics transformer: count every API call + capture latency + classify errors.
// Sits below auto-retry so each retry attempt is counted (truth in numbers).
bot.api.config.use(async (prev, method, payload, signal) => {
  const startedAt = Date.now();
  try {
    const result = await prev(method, payload, signal);
    metrics.recordApiCall(method, Date.now() - startedAt);
    return result;
  } catch (err: unknown) {
    metrics.recordApiCall(method, Date.now() - startedAt);
    const errRec = err as { error_code?: number };
    if (typeof errRec?.error_code === "number") {
      metrics.recordApiError(method, errRec.error_code);
    } else {
      metrics.recordApiError(method, "unknown");
    }
    throw err;
  }
});

// Sequentialize updates per chat to prevent race conditions,
// but allow different chats to be processed concurrently
bot.use(sequentialize((ctx) => {
  const chatId = ctx.chat?.id;
  return chatId ? [String(chatId)] : undefined;
}));

// --- Per-user command rate limiting (P1 abuse protection) ---
// Drops commands from users who exceed RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_MS.
// Owner is exempt. Callback queries and non-command messages pass through.
const RATE_LIMIT_MAX = 20; // commands per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute sliding window
const RATE_LIMIT_COOLDOWN_MS = 60_000; // how long to drop after exceeding
interface RateLimitEntry {
  count: number;
  windowStart: number;
  warned: boolean;
  blockedUntil: number;
}
const userCommandCounts = new Map<number, RateLimitEntry>();

bot.use(async (ctx, next) => {
  // Only rate-limit text commands
  const text = ctx.message?.text;
  if (!text || !text.startsWith("/")) return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Exempt the bot owner
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (userId === ownerId) return next();

  const now = Date.now();
  let entry = userCommandCounts.get(userId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, warned: false, blockedUntil: 0 };
    userCommandCounts.set(userId, entry);
  }

  // Already in cooldown — silently drop
  if (now < entry.blockedUntil) {
    metrics.recordRateLimitHit();
    return; // drop without next()
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    entry.blockedUntil = now + RATE_LIMIT_COOLDOWN_MS;
    metrics.recordRateLimitHit();
    if (!entry.warned) {
      entry.warned = true;
      try {
        await ctx.reply(
          "⚠️ Too many commands. Please slow down — try again in a minute."
        );
      } catch {
        // Ignore reply failures (group restrictions, etc.)
      }
    }
    return; // drop the command
  }

  // Count the command for metrics (strip leading / and any @botusername)
  const cmdMatch = text.match(/^\/([a-zA-Z0-9_]+)/);
  if (cmdMatch) metrics.recordCommand(cmdMatch[1]);

  return next();
});

// Periodically clean up old rate-limit entries to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 5;
  for (const [userId, entry] of userCommandCounts) {
    if (entry.windowStart < cutoff && entry.blockedUntil < Date.now()) {
      userCommandCounts.delete(userId);
    }
  }
}, 5 * 60_000);

// --- Auto-track groups + auto-delete command messages ---
bot.use(async (ctx, next) => {
  const isGroup =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

  // Auto-track: any activity from a group ensures it's in bot_groups
  if (isGroup && ctx.chat) {
    const chatId = ctx.chat.id;
    const title = ctx.chat.title || "";
    const existing = db.getBotGroup(chatId);
    if (!existing) {
      db.upsertBotGroup(chatId, title, "member");
    } else if (title && existing.title !== title) {
      // Update title if it changed
      db.upsertBotGroup(chatId, title, existing.bot_status);
    }

    // Keep a saved default's label current when Telegram sends a topic rename
    // service message. A normal /setraffletopic command discovers the initial
    // name from its nested topic-creation service message.
    rememberForumTopicFromMessage(chatId, ctx.message);
  }

  const isCommand = ctx.message?.text?.startsWith("/");
  if (isGroup && isCommand) {
    try {
      await ctx.deleteMessage();
    } catch {
      // Bot may not have delete permission
    }
  }

  await next();
});

// Legacy group commands route into private workflows. Creation can start
// immediately; other actions retain a private button until their picker opens.
const GROUP_MEMBER_COMMANDS = [
  { command: "raffles", description: "View open raffles privately" },
  { command: "myentries", description: "See your active entries privately" },
  { command: "bugreport", description: "Open the bug report wizard" },
  { command: "help", description: "Open raffle bot help" },
];

const GROUP_ADMIN_COMMANDS = [
  { command: "newraffle", description: "Start a new raffle wizard" },
  { command: "setraffletopic", description: "Save this topic as the raffle default" },
  { command: "raffles", description: "View open raffles privately" },
  { command: "draw", description: "Draw raffle winners privately" },
  { command: "templates", description: "Manage raffle templates privately" },
  { command: "editraffle", description: "Edit an active raffle privately" },
  { command: "cancelraffle", description: "Cancel a raffle privately" },
  { command: "rerun", description: "Re-run a past raffle privately" },
  { command: "exportentries", description: "Export participant list privately" },
  { command: "myentries", description: "See your active entries privately" },
  { command: "rafflehistory", description: "View raffle history privately" },
  { command: "groupstats", description: "View group raffle stats privately" },
  { command: "defaults", description: "Set raffle defaults privately" },
  { command: "setupcheck", description: "Check bot setup privately" },
  { command: "referrals", description: "View referral stats privately" },
  { command: "bugreport", description: "Open the bug report wizard" },
  { command: "language", description: "Set the bot language privately" },
  { command: "timezone", description: "Set the group timezone privately" },
  { command: "help", description: "Open raffle bot help" },
];

const PRIVATE_ADMIN_ACTIONS: Record<string, string> = {
  newraffle: "create",
  draw: "draw",
  cancelraffle: "cancel",
  rafflehistory: "history",
  exportentries: "export",
  rerun: "rerun",
  savetemplate: "templates",
  templates: "templates",
  deletetemplate: "templates",
  usetemplate: "templates",
  recurring: "templates",
  editraffle: "edit",
  language: "language",
  timezone: "timezone",
  groupstats: "stats",
  defaults: "defaults",
  setupcheck: "setup",
  referrals: "referrals",
};

bot.use(async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) return next();
  const text = ctx.message?.text || "";
  const match = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s|$)/i);
  const action = match ? PRIVATE_ADMIN_ACTIONS[match[1].toLowerCase()] : undefined;
  if (!action) return next();

  try { await ctx.deleteMessage(); } catch {}
  if (action === "create") {
    await startWizard(ctx);
    return;
  }
  try {
    const rerunDestination = encodeRerunDestination(
      ctx.message?.message_thread_id
        ? { kind: "topic", threadId: ctx.message.message_thread_id }
        : { kind: "general" }
    );
    const callbackData = action === "rerun"
      ? `admin_do_${action}_${ctx.chat.id}_${rerunDestination}`
      : `admin_do_${action}_${ctx.chat.id}`;
    await ctx.api.sendMessage(
      ctx.from.id,
      `<b>${escapeHtml(ctx.chat.title || "Group")} Admin Center</b>\n\nContinue this action privately:`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Continue", callbackData).row()
          .text("Choose Another Group", "admin_groups"),
      }
    );
  } catch {
    // The user has not started the bot in DMs yet. Stay silent in the group.
  }
});

// --- Register commands ---
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("manage", handleManage);
bot.command("newraffle", handleNewRaffle);
bot.command("setraffletopic", handleSetRaffleTopic);
bot.command("raffles", handleListRaffles);
bot.command("draw", handleDraw);
bot.command("cancelraffle", handleCancelRaffle);
bot.command("myentries", handleMyEntries);
bot.command("rafflehistory", handleRaffleHistory);
bot.command("exportentries", handleExportEntries);
bot.command("rerun", handleRerun);
bot.command("savetemplate", handleSaveTemplate);
bot.command("templates", handleTemplates);
bot.command("deletetemplate", handleDeleteTemplate);
bot.command("usetemplate", handleUseTemplate);
bot.command("recurring", handleRecurring);
bot.command("editraffle", handleEditRaffle);
bot.command("language", handleLanguage);
bot.command("timezone", handleTimezone);
bot.command("stats", handleStats);
bot.command("health", handleHealth);
bot.command("metrics", handleMetrics);
bot.command("active", handleActive);
bot.command("referralstats", handleReferralStats);
bot.command("groupstats", handleGroupStats);
bot.command("defaults", handleDefaults);
bot.command("setupcheck", handleSetupCheck);
bot.command("referrals", handleReferrals);
bot.command("bugreport", handleBugReport);

// --- Callback query safety net ---
// Ensures every callback query gets answered even if the handler throws.
// Telegram penalizes bots that leave callback queries unanswered.
bot.on("callback_query:data", async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // Silently ignore stale callbacks from before restart
    const errMsg = String((err as Record<string, unknown>)?.description ?? err);
    if (!errMsg.includes("query is too old")) {
      console.error("Callback query handler error:", err);
    }
    try {
      await ctx.answerCallbackQuery({ text: "⚠️ Something went wrong. Please try again.", show_alert: true });
    } catch {
      // answerCallbackQuery itself failed (e.g. query too old) — nothing more we can do
    }
  }
});

// --- Register callback queries ---
bot.callbackQuery(/^enter_\d+$/, handleEnterCallback);
bot.callbackQuery(/^leave_\d+$/, handleLeaveCallback);
bot.callbackQuery(/^entries_\d+(_\d+)?$/, handleEntriesCallback);
bot.callbackQuery(/^draw_/, handleDrawCallback);
bot.callbackQuery(/^export_/, handleExportCallback);
bot.callbackQuery(/^admin_/, handleAdminCallback);
bot.callbackQuery(/^home_/, handleHomeCallback);
bot.callbackQuery(/^access_/, handleAccessCallback);

// --- Wizard callback queries ---
bot.callbackQuery(/^wiz_winners_\d+$/, handleWinnersCallback);
bot.callbackQuery("wiz_winners_custom", handleWinnersCustomCallback);
bot.callbackQuery(/^wiz_time_/, handleTimeCallback);
bot.callbackQuery(/^wiz_opt_/, handleOptionsCallback);
bot.callbackQuery(/^wiz_sched_/, handleSchedPickerCallback);
bot.callbackQuery(/^wsc:/, handleCalendarPickerCallback);
bot.callbackQuery(/^wotz:/, handleStandaloneTzCallback);

// --- Edit wizard callback queries ---
bot.callbackQuery(/^edit_/, handleEditCallback);

// --- Rerun callback queries ---
bot.callbackQuery(/^rerun_/, handleRerunCallback);

// --- Template hub callback queries ---
bot.callbackQuery(/^tmpl_/, handleTemplateCallback);

// --- Cancel raffle callback queries ---
bot.callbackQuery(/^cancel_/, handleCancelCallback);

// --- Repost raffle callback queries ---
bot.callbackQuery(/^repost_\d+$/, handleRepostCallback);

// --- Bug report callback ---
bot.callbackQuery("bugreport_skip", handleBugReportSkip);

// --- Group admin management callbacks ---
bot.callbackQuery(/^def_/, handleDefaultsCallback);
bot.callbackQuery(/^refdash_-?\d+_\d+$/, handleReferralsCallback);
bot.callbackQuery(/^langset_/, handleLanguageCallback);
bot.callbackQuery(/^tzset_/, handleTimezoneCallback);

// --- Template wizard callback queries ---
bot.callbackQuery(/^twiz_winners_\d+$/, handleTmplWinnersCallback);
bot.callbackQuery("twiz_winners_custom", handleTmplWinnersCustomCallback);
bot.callbackQuery(/^twiz_time_/, handleTmplTimeCallback);
bot.callbackQuery(/^twiz_opt_/, handleTmplOptionsCallback);

// --- Catch-all for unmatched callback queries ---
// Prevents Telegram from flagging unanswered callbacks for old/unknown button patterns
bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
});

// --- Detect forwarded raffle posts and reply with redirect ---
bot.on("message", async (ctx, next) => {
  const msg = ctx.message;
  if (!msg || !msg.forward_origin) return next();

  // Only handle forwards from this bot
  const origin = msg.forward_origin;
  let isFromBot = false;
  if (origin.type === "user" && origin.sender_user.id === bot.botInfo.id) {
    isFromBot = true;
  }
  if (!isFromBot) return next();

  // Extract raffle title from forwarded text/caption
  const text = msg.text || msg.caption || "";
  const titleMatch = text.match(/🎟\s+(.+)/);
  if (!titleMatch) return next();

  const title = titleMatch[1].trim();
  const raffle = db.findOpenRaffleByTitle(title);
  if (!raffle || !raffle.message_id) return next();

  const link = buildMessageLink(raffle.chat_id, raffle.message_id);
  if (!link) return next();

  const keyboard = new InlineKeyboard().url("🎟 Enter Raffle", link);
  try {
    await ctx.reply(
      `📌 This is a forwarded copy — buttons won't work here.\nTap below to go to the original raffle:`,
      { reply_markup: keyboard, reply_parameters: { message_id: msg.message_id } }
    );
  } catch {
    // May not have permission to reply in this chat
  }
});

// --- Handle text messages (for wizard responses in DMs) ---
bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;
  // Skip commands — they're handled above
  if (ctx.message.text.startsWith("/")) return;

  // Only process wizard messages in private chat (DMs)
  if (ctx.chat.type !== "private") return;

  // Check if user has an active edit wizard first
  const editState = getActiveEditWizard(ctx.from.id);
  if (editState && editState.editingField) {
    await handleEditTextMessage(ctx);
    return;
  }

  // Check if user has an active bug report
  const bugState = getActiveBugReport(ctx.from.id);
  if (bugState) {
    await handleBugReportMessage(ctx);
    return;
  }

  // Check if user has an active template wizard
  const tmplState = getActiveTemplateWizard(ctx.from.id);
  if (tmplState) {
    await handleTemplateWizardMessage(ctx);
    return;
  }

  // Check if user has an active creation wizard
  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardMessage(ctx);
});

// --- Handle photo messages (for wizard image upload or bug report in DMs) ---
bot.on("message:photo", async (ctx) => {
  if (!ctx.from) return;
  if (ctx.chat.type !== "private") return;

  // Bug report screenshot
  const bugState = getActiveBugReport(ctx.from.id);
  if (bugState) {
    await handleBugReportPhoto(ctx);
    return;
  }

  const editState = getActiveEditWizard(ctx.from.id);
  if (editState) {
    await handleEditPhotoMessage(ctx);
    return;
  }

  const templateState = getActiveTemplateWizard(ctx.from.id);
  if (templateState) {
    await handleTemplateWizardPhoto(ctx);
    return;
  }

  // Raffle wizard image
  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardPhoto(ctx);
});

// --- Interval re-entry guard (P1 reliability) ---
// Wraps an async function so that if a previous invocation is still running,
// the new tick is skipped (with a warning) instead of stacking up behind it.
// This prevents one slow interval call from cascading into pile-ups that
// exhaust memory or pin the event loop.
function makeNonOverlapping(
  fn: () => Promise<void> | void,
  name: string
): () => Promise<void> {
  let running = false;
  let lastWarnAt = 0;
  let skippedSinceWarn = 0;
  return async () => {
    if (running) {
      skippedSinceWarn++;
      // Throttle the warning so we don't spam logs every tick
      const now = Date.now();
      if (now - lastWarnAt > 60_000) {
        logger.warn(
          { interval: name, skipped_count: skippedSinceWarn },
          "Interval previous run still in progress, skipping ticks"
        );
        lastWarnAt = now;
        skippedSinceWarn = 0;
      }
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      await fn();
    } catch (err) {
      logger.error({ interval: name, err }, "Interval handler failed");
    } finally {
      const elapsed = Date.now() - startedAt;
      // Surface slow intervals (>5s) so we can investigate before they cascade
      if (elapsed > 5000) {
        logger.warn(
          { interval: name, elapsed_ms: elapsed },
          "Interval took longer than 5s — watch for re-entry skips"
        );
      }
      running = false;
    }
  };
}

// --- Backups & WAL checkpoints (P0 reliability) ---

const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BACKUP_DIR = "/data/backups";
const BACKUP_RETENTION = 48; // Keep last 48 hourly backups (2 days)

async function backupDatabase(): Promise<void> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = path.join(BACKUP_DIR, `raffle.db.${ts}.bak`);

    // SQLite online backup — safe even while bot is writing
    await db.getDb().backup(dest);

    const size = fs.statSync(dest).size;
    console.log(`✓ Backup created: ${path.basename(dest)} (${(size / 1024 / 1024).toFixed(2)} MB)`);

    rotateBackups();
  } catch (err) {
    console.error("Backup failed:", err);
    notifyOwner(
      `🔴 <b>Database backup FAILED</b>\n\n` +
        `Error: <code>${escapeHtml(String((err as Error).message || err))}</code>\n\n` +
        `Backups won't run until this is resolved. Please investigate.`
    ).catch(() => {});
  }
}

function rotateBackups(): void {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("raffle.db.") && f.endsWith(".bak"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length <= BACKUP_RETENTION) return;

    const toDelete = files.slice(BACKUP_RETENTION);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      } catch (err) {
        console.error(`Failed to delete old backup ${f.name}:`, err);
      }
    }
    if (toDelete.length > 0) {
      console.log(`Rotated ${toDelete.length} old backup(s); ${BACKUP_RETENTION} kept`);
    }
  } catch (err) {
    console.error("Backup rotation failed:", err);
  }
}

function walCheckpoint(): void {
  try {
    // TRUNCATE: checkpoint and shrink WAL file back to zero
    const result = db.getDb().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    if (result.busy === 0 && result.log > 100) {
      console.log(`WAL checkpoint: ${result.checkpointed} pages checkpointed (log was ${result.log} pages)`);
    }
  } catch (err) {
    console.error("WAL checkpoint failed:", err);
  }
}

// --- Owner notification helper ---
async function notifyOwner(message: string): Promise<void> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0) return;
  try {
    await bot.api.sendMessage(ownerId, message, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    metrics.recordOwnerAlert();
  } catch (err) {
    console.error("Failed to DM owner:", err);
  }
}

// Track when we last sent a message to each chat so we can throttle per-chat sends
const lastChatSendAt = new Map<number, number>();
const chatThrottleQueues = new Map<number, Promise<void>>();
const PER_CHAT_MIN_INTERVAL_MS = 5500; // ~5.5s between sends to same chat

async function throttleChat(chatId: number): Promise<void> {
  const previous = chatThrottleQueues.get(chatId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const now = Date.now();
      const last = lastChatSendAt.get(chatId);
      if (last !== undefined) {
        const elapsed = now - last;
        if (elapsed < PER_CHAT_MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, PER_CHAT_MIN_INTERVAL_MS - elapsed));
        }
      }
      lastChatSendAt.set(chatId, Date.now());
    });

  chatThrottleQueues.set(chatId, next);
  try {
    await next;
  } finally {
    if (chatThrottleQueues.get(chatId) === next) {
      chatThrottleQueues.delete(chatId);
    }
  }
}

// --- Auto-draw expired raffles ---
const EXPIRY_CHECK_INTERVAL = 10_000; // 10 seconds - check more frequently for quicker auto-draw
const ANNOUNCEMENT_GIVE_UP_HOURS = 24; // Mark as failed after retrying for this long
const STUCK_ALERT_MINUTES = 15; // Alert owner after a raffle has been stuck this long

async function processExpiredRaffle(raffle: Raffle): Promise<void> {
  console.log(`Auto-drawing expired raffle: ${raffle.id} - ${raffle.title}`);

  // Mark as drawn IMMEDIATELY to prevent double-processing
  db.markRaffleDrawn(raffle.id);

  // Clean up in-memory tracking maps for this raffle
  lastRefreshTime.delete(raffle.id);
  raffleIsPhoto.delete(raffle.id);
  lastRenderedCaption.delete(raffle.id);
  endingSoonSent.delete(raffle.id);
  // Revoke referral links via job queue — survives bot restarts
  enqueue("revoke_referrals", { raffleId: raffle.id });

  const entryCount = db.getEntryCount(raffle.id);
  const lang = db.getChatLanguage(raffle.chat_id);
  const threadOpts = raffle.thread_id ? { message_thread_id: raffle.thread_id } : {};

  if (entryCount === 0) {
    db.recordAnnounceAttempt(raffle.id);
    await throttleChat(raffle.chat_id);
    try {
      await bot.api.sendMessage(
        raffle.chat_id,
        `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n⏰ Raffle ended. ${t(lang, "winner.no_entries")}`,
        { parse_mode: "HTML", ...threadOpts }
      );
      db.markRaffleAnnounced(raffle.id);
    } catch (err) {
      const errCode = (err as { error_code?: number }).error_code;
      if (errCode === 403) {
        db.markRaffleAnnounced(raffle.id);
        console.log(`Initial announce: bot kicked from ${raffle.chat_id}, marking raffle ${raffle.id} announced`);
      } else {
        console.error(`Failed to announce empty raffle ${raffle.id}:`, err);
      }
    }
  } else {
    const entries = db.getEntriesForRaffle(raffle.id);
    const entryNames = entries.map((e) => e.user_display_name);
    const winners = db.selectWinners(raffle.id);

    // Only show countdown if raffle expired recently (within 2 minutes) and animation is enabled
    const expiredAt = new Date(raffle.ends_at + "Z");
    const staleness = Date.now() - expiredAt.getTime();
    const isRecent = staleness < 2 * 60 * 1000;

    if (isRecent && entryNames.length >= 1 && raffle.show_animation) {
      await sendWheelSpin(bot.api, raffle.chat_id, raffle.thread_id);
    }

    // Announce winners with embedded "WINNERS DRAWN" banner
    db.recordAnnounceAttempt(raffle.id);
    await throttleChat(raffle.chat_id);
    try {
      await sendWinnerPost(bot.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);
      db.markRaffleAnnounced(raffle.id);
    } catch (err) {
      const errCode = (err as { error_code?: number }).error_code;
      if (errCode === 403) {
        db.markRaffleAnnounced(raffle.id);
        console.log(`Initial announce: bot kicked from ${raffle.chat_id}, marking raffle ${raffle.id} announced`);
      } else {
        console.error(`Failed to announce winners for raffle ${raffle.id} — will retry:`, err);
      }
    }

    // DM winners and creator via job queue — survives bot restarts
    enqueue("notify_winners", { raffleId: raffle.id });
  }

  // Update the original raffle post with "closed" banner
  if (raffle.message_id) {
    try {
      const updatedRaffle = db.getRaffleById(raffle.id);
      if (updatedRaffle) {
        let text = formatRaffleMessage(updatedRaffle, entryCount, lang);

        const drawnWinners = db.getWinnersForRaffle(raffle.id);
        if (drawnWinners.length > 0) {
          const winnerLabel = drawnWinners.length > 1
            ? t(lang, "winner.label_plural")
            : t(lang, "winner.label");
          text += `\n\n🏆 <b>${winnerLabel}:</b>\n`;
          drawnWinners.forEach((w) => {
            const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
            if (w.prize) {
              text += `  🎁 ${mention} — ${escapeHtml(w.prize)}\n`;
            } else {
              text += `  • ${mention}\n`;
            }
          });
        }

        // Try to swap the banner to "closed"
        const closedBannerFileId = await getBannerFileId(bot.api, raffle.chat_id, "closed");
        if (closedBannerFileId) {
          try {
            await bot.api.editMessageMedia(
              raffle.chat_id,
              raffle.message_id,
              {
                type: "photo",
                media: closedBannerFileId,
                caption: text,
                parse_mode: "HTML",
              }
            );
          } catch (err) {
            console.error(`Failed to swap banner to closed:`, err);
            // Fallback to just caption update
            await bot.api.editMessageCaption(
              raffle.chat_id,
              raffle.message_id,
              { caption: text, parse_mode: "HTML" }
            );
          }
        } else {
          await bot.api.editMessageCaption(
            raffle.chat_id,
            raffle.message_id,
            { caption: text, parse_mode: "HTML" }
          );
        }
      }
    } catch {
      // Message may be too old or deleted
    }
  }
}

async function retryUnannouncedRaffles(): Promise<void> {
  // First, give up on any raffles that have been retrying forever
  const giveUps = db.getRafflesToGiveUpOn(ANNOUNCEMENT_GIVE_UP_HOURS);
  if (giveUps.length > 0) {
    for (const r of giveUps) {
      db.markAnnounceFailed(r.id);
      console.log(`Retry: giving up on raffle ${r.id} after ${ANNOUNCEMENT_GIVE_UP_HOURS}h — ${r.title}`);
    }
    await notifyOwner(
      `⚠️ <b>Gave up announcing ${giveUps.length} raffle${giveUps.length !== 1 ? "s" : ""}</b>\n\n` +
        `These raffles were drawn but couldn't be announced after ${ANNOUNCEMENT_GIVE_UP_HOURS}h of retries:\n` +
        giveUps.slice(0, 10).map((r) => `• <code>${r.id}</code> — ${escapeHtml(r.title)} (chat <code>${r.chat_id}</code>)`).join("\n") +
        (giveUps.length > 10 ? `\n…and ${giveUps.length - 10} more` : "")
    );
  }

  // Alert owner once when raffles cross the "stuck" threshold
  const stuck = db.getStuckUnnotifiedRaffles(STUCK_ALERT_MINUTES);
  if (stuck.length > 0) {
    await notifyOwner(
      `🟡 <b>${stuck.length} raffle${stuck.length !== 1 ? "s" : ""} stuck unannounced &gt;${STUCK_ALERT_MINUTES} min</b>\n\n` +
        stuck.slice(0, 10).map((r) => `• <code>${r.id}</code> — ${escapeHtml(r.title)} (chat <code>${r.chat_id}</code>, ${r.announce_attempts} attempts)`).join("\n") +
        (stuck.length > 10 ? `\n…and ${stuck.length - 10} more` : "") +
        `\n\nRetries will continue. Use /health to check status.`
    );
    for (const r of stuck) db.markOwnerAlerted(r.id);
  }

  const unannounced = db.getUnannouncedDrawnRaffles();
  if (unannounced.length === 0) return;

  // Sort by chat_id then drawn_at so we can apply per-chat throttling
  unannounced.sort((a, b) => {
    if (a.chat_id !== b.chat_id) return a.chat_id - b.chat_id;
    return (a.drawn_at || "").localeCompare(b.drawn_at || "");
  });

  for (const raffle of unannounced) {
    const winners = db.getWinnersForRaffle(raffle.id);
    const entryCount = db.getEntryCount(raffle.id);
    const lang = db.getChatLanguage(raffle.chat_id);

    // Per-chat throttle so we don't burst into the same chat
    await throttleChat(raffle.chat_id);
    db.recordAnnounceAttempt(raffle.id);

    if (entryCount === 0) {
      const threadOpts = raffle.thread_id ? { message_thread_id: raffle.thread_id } : {};
      try {
        await bot.api.sendMessage(
          raffle.chat_id,
          `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n⏰ Raffle ended. ${t(lang, "winner.no_entries")}`,
          { parse_mode: "HTML", ...threadOpts }
        );
        db.markRaffleAnnounced(raffle.id);
        console.log(`Retry: announced empty raffle ${raffle.id}`);
      } catch (err: unknown) {
        const errCode = (err as { error_code?: number }).error_code;
        if (errCode === 403) {
          // Bot was kicked/blocked — stop retrying
          db.markRaffleAnnounced(raffle.id);
          console.log(`Retry: giving up on raffle ${raffle.id} — bot no longer in chat (403)`);
        } else {
          console.error(`Retry: still can't announce empty raffle ${raffle.id} (attempt ${raffle.announce_attempts + 1}):`, err);
        }
      }
    } else if (winners.length > 0) {
      try {
        await sendWinnerPost(bot.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);
        db.markRaffleAnnounced(raffle.id);
        console.log(`Retry: announced winners for raffle ${raffle.id} - ${raffle.title}`);
        // Also try to DM winners via job queue
        enqueue("notify_winners", { raffleId: raffle.id });
      } catch (err: unknown) {
        const errCode = (err as { error_code?: number }).error_code;
        if (errCode === 403) {
          // Bot was kicked/blocked — stop retrying
          db.markRaffleAnnounced(raffle.id);
          console.log(`Retry: giving up on raffle ${raffle.id} — bot no longer in chat (403)`);
        } else {
          console.error(`Retry: still can't announce raffle ${raffle.id} (attempt ${raffle.announce_attempts + 1}):`, err);
        }
      }
    }
  }
}

async function checkExpiredRaffles(): Promise<void> {
  try {
    const expired = db.getExpiredOpenRaffles();
    // Process expired raffles concurrently in batches of 3
    const BATCH_SIZE = 3;
    for (let i = 0; i < expired.length; i += BATCH_SIZE) {
      await Promise.all(
        expired.slice(i, i + BATCH_SIZE).map((raffle) =>
          processExpiredRaffle(raffle).catch((err) =>
            console.error(`Error processing expired raffle ${raffle.id}:`, err)
          )
        )
      );
    }

    // Retry any drawn raffles whose announcements previously failed
    await retryUnannouncedRaffles();
  } catch (err) {
    console.error("Error checking expired raffles:", err);
  }
}

// --- Refresh countdowns on active raffle posts ---
const COUNTDOWN_REFRESH_INTERVAL = 60_000; // 1 minute
const ENDING_SOON_THRESHOLD = 5 * 60 * 1000; // 5 minutes
const endingSoonSent = new Set<number>(); // raffle IDs that already got a reminder

// Track which raffles are photo-based vs text-only to avoid wasted API calls
const raffleIsPhoto = new Map<number, boolean>();

// Per-raffle cache of the last rendered caption so we can skip API calls
// when nothing actually changed (saves Telegram quota at high raffle counts).
const lastRenderedCaption = new Map<number, string>();

async function refreshRaffleMessage(raffle: Raffle): Promise<void> {
  if (!raffle.message_id) return;

  const count = db.getEntryCount(raffle.id);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffle.id) : count;
  const lang = db.getChatLanguage(raffle.chat_id);
  const botUsername = bot.botInfo.username;

  const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);
  const caption = formatRaffleMessage(raffle, count, lang);

  // Skip if neither the caption nor the entry count has changed since last render.
  // Telegram returns 400 "message is not modified" on no-op edits — wasted API call.
  const cacheKey = `${caption}\x00${displayCount}`;
  const cached = lastRenderedCaption.get(raffle.id);
  if (cached === cacheKey) return;

  const isPhoto = raffleIsPhoto.get(raffle.id);
  // (The API transformer throttles per-chat automatically, no manual throttle needed)

  if (isPhoto === false) {
    // Known text-only — skip editMessageCaption entirely
    try {
      await bot.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
      lastRenderedCaption.set(raffle.id, cacheKey);
    } catch { /* unchanged or deleted */ }
    return;
  }

  try {
    await bot.api.editMessageCaption(raffle.chat_id, raffle.message_id, { caption, parse_mode: "HTML", reply_markup: keyboard });
    raffleIsPhoto.set(raffle.id, true);
    lastRenderedCaption.set(raffle.id, cacheKey);
  } catch {
    // Might be text-only — try editMessageText
    try {
      await bot.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
      raffleIsPhoto.set(raffle.id, false);
      lastRenderedCaption.set(raffle.id, cacheKey);
    } catch { /* unchanged or deleted */ }
  }
}

// Track last refresh time for each raffle (for smart refresh intervals)
const lastRefreshTime = new Map<number, number>();

// Determine refresh interval based on time remaining
function getRefreshInterval(remainingMs: number): number {
  const TEN_MINUTES = 10 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  if (remainingMs <= TEN_MINUTES) return 60 * 1000;       // <10 min: every 1 minute
  if (remainingMs <= ONE_HOUR) return 5 * 60 * 1000;      // 10-60 min: every 5 minutes
  if (remainingMs <= SIX_HOURS) return 15 * 60 * 1000;    // 1-6 hours: every 15 minutes
  return 30 * 60 * 1000;                                   // 6+ hours: every 30 minutes
}

async function refreshCountdowns(): Promise<void> {
  try {
    const raffles = db.getOpenRafflesWithEndTime();
    const now = Date.now();
    let refreshedCount = 0;

    // Collect tasks to run in parallel batches
    const refreshTasks: Array<() => Promise<void>> = [];

    for (const raffle of raffles) {
      const endsAt = new Date(raffle.ends_at + "Z");
      const remaining = endsAt.getTime() - now;

      // Send "ending soon" reminder when <= 5 minutes remain
      if (
        remaining > 0 &&
        remaining <= ENDING_SOON_THRESHOLD &&
        !endingSoonSent.has(raffle.id)
      ) {
        endingSoonSent.add(raffle.id);
        const entryCount = raffle.referral_enabled ? db.getTotalEntryCount(raffle.id) : db.getEntryCount(raffle.id);
        const mins = Math.ceil(remaining / 60_000);
        refreshTasks.push(async () => {
          try {
            await throttleChat(raffle.chat_id);
            await bot.api.sendMessage(
              raffle.chat_id,
              `⏰ <b>${escapeHtml(raffle.title)}</b> ends in ${mins} minute${mins > 1 ? "s" : ""}! ` +
                `${entryCount} entr${entryCount === 1 ? "y" : "ies"} so far — Don't miss out!`,
              {
                parse_mode: "HTML",
                reply_parameters: raffle.message_id ? { message_id: raffle.message_id } : undefined,
                ...(raffle.thread_id ? { message_thread_id: raffle.thread_id } : {}),
              }
            );
          } catch {
            // Couldn't send reminder — not critical
          }
        });
      }

      // Smart refresh: only update if enough time has passed based on remaining time
      if (remaining > 0) {
        const lastRefresh = lastRefreshTime.get(raffle.id) || 0;
        const refreshInterval = getRefreshInterval(remaining);
        const timeSinceLastRefresh = now - lastRefresh;

        if (timeSinceLastRefresh >= refreshInterval) {
          lastRefreshTime.set(raffle.id, now);
          refreshedCount++;
          refreshTasks.push(() => refreshRaffleMessage(raffle));
        }
      } else {
        // Clean up tracking for ended raffles to prevent memory growth
        lastRefreshTime.delete(raffle.id);
        raffleIsPhoto.delete(raffle.id);
        lastRenderedCaption.delete(raffle.id);
        endingSoonSent.delete(raffle.id);
      }
    }

    // Run refresh tasks in parallel batches of 10 to avoid rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < refreshTasks.length; i += BATCH_SIZE) {
      await Promise.all(refreshTasks.slice(i, i + BATCH_SIZE).map(fn => fn()));
    }

    if (refreshedCount > 0) {
      console.log(`Refreshed ${refreshedCount} of ${raffles.length} active raffle(s)`);
    }
  } catch (err) {
    console.error("Error refreshing countdowns:", err);
  }
}

// --- Auto-purge completed raffle data ---
const PURGE_CHECK_INTERVAL = 60 * 60 * 1000; // check every hour

function purgeOldData(): void {
  if (DATA_RETENTION_HOURS <= 0) return;
  try {
    const purged = db.purgeExpiredData(DATA_RETENTION_HOURS);
    if (purged > 0) {
      console.log(`Data retention: purged ${purged} completed raffle(s)`);
    }
  } catch (err) {
    console.error("Error purging old data:", err);
  }
}

// --- Auto-create recurring raffles from templates ---
const RECURRING_CHECK_INTERVAL = 60_000; // 1 minute

async function checkRecurringTemplates(): Promise<void> {
  try {
    const dueTemplates = db.claimDueRecurringTemplates();
    for (const template of dueTemplates) {
      console.log(`Creating recurring raffle from template: ${template.name} (ID: ${template.id})`);

      let endsAt: string | null = null;
      if (template.duration_minutes) {
        const endDate = new Date(Date.now() + template.duration_minutes * 60 * 1000);
        endsAt = endDate
          .toISOString()
          .replace("T", " ")
          .replace("Z", "")
          .split(".")[0];
      }
      let startsAt: string | null = null;
      if (template.starts_after_minutes) {
        const startDate = new Date(Date.now() + template.starts_after_minutes * 60 * 1000);
        startsAt = startDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      }

      const groupDefaults = db.getGroupDefaults(template.chat_id);
      const resolvedThreadId = resolveTemplateThreadId(
        template.thread_id,
        groupDefaults?.thread_id
      );
      const resolvedDestinationName = resolvedThreadId
        ? db.getForumTopicName(template.chat_id, resolvedThreadId) ||
          (groupDefaults?.thread_id === resolvedThreadId ? groupDefaults.thread_name : null) ||
          "the saved raffle topic"
        : "General";
      const raffle = db.createRaffle({
        chat_id: template.chat_id,
        thread_id: resolvedThreadId,
        creator_id: template.creator_id,
        creator_name: "Recurring Raffle",
        title: template.title,
        description: template.description || "",
        prize: template.prize,
        prizes: template.prizes,
        max_entries: template.max_entries,
        max_winners: template.max_winners,
        ends_at: endsAt,
        starts_at: startsAt,
        display_timezone: template.display_timezone || db.getChatTimezone(template.chat_id),
        required_chat_id: template.required_chat_id,
        required_chat_title: template.required_chat_title,
        sponsor_name: template.sponsor_name,
        anonymous: template.anonymous,
        image_file_id: template.image_file_id,
        auto_pin: template.auto_pin,
        min_account_age_days: template.min_account_age_days,
        require_username: template.require_username,
        winner_cooldown: template.winner_cooldown,
        show_animation: template.show_animation,
        referral_enabled: template.referral_enabled,
        max_referral_entries: template.max_referral_entries,
        revoke_referral_links: template.revoke_referral_links,
      });

      let postSucceeded = false;
      try {
        const recLang = db.getChatLanguage(template.chat_id);
        const botUsername = bot.botInfo.username;

        const keyboard = buildRaffleKeyboard(raffle, 0, recLang, botUsername);

        const msgId = await sendRafflePost(
          bot.api,
          template.chat_id,
          "open",
          formatRaffleMessage(raffle, 0, recLang),
          keyboard,
          raffle.image_file_id,
          raffle.thread_id
        );
        postSucceeded = Boolean(msgId);

        if (msgId) {
          db.updateRaffleMessageId(raffle.id, msgId);
          if (raffle.auto_pin) {
            try {
              await bot.api.pinChatMessage(template.chat_id, msgId, { disable_notification: true });
            } catch {}
          }
        } else {
          const notified = await handleRecurringPostFailure(
            bot.api,
            template,
            raffle.id,
            resolvedDestinationName
          );
          console.error(
            `Recurring raffle post failed for template ${template.id}; template paused` +
              (notified ? " and creator notified" : "; creator notification failed")
          );
        }
      } catch (err) {
        console.error(`Failed to post recurring raffle for template ${template.id}:`, err);
        if (postSucceeded) {
          console.error(
            `Recurring raffle ${raffle.id} was posted but final database processing failed; ` +
              `leaving the template active to avoid deleting a live raffle`
          );
          continue;
        }
        const notified = await handleRecurringPostFailure(
          bot.api,
          template,
          raffle.id,
          resolvedDestinationName
        );
        if (!notified) {
          console.error(`Failed to notify creator for paused recurring template ${template.id}`);
        }
      }

      // Next run was claimed before work began, so crashes cannot duplicate this occurrence.
    }
  } catch (err) {
    console.error("Error checking recurring templates:", err);
  }
}

// --- Inline mode ---
bot.on("inline_query", async (ctx) => {
  const query = ctx.inlineQuery.query.trim();

  // Show open raffles the user's groups have
  // For now, show a simple "create raffle" suggestion
  try {
    const results = [];

    if (!query) {
      results.push({
        type: "article" as const,
        id: "help",
        title: "Raffle Bot",
        description: "Add me to a group and use /newraffle to create raffles!",
        input_message_content: {
          message_text:
            "🎟 <b>Raffle Bot</b>\n\nAdd me to a group chat and use /newraffle to create interactive raffles with prizes, auto-draw, templates, and more!",
          parse_mode: "HTML" as const,
        },
      });
    } else {
      results.push({
        type: "article" as const,
        id: "create",
        title: `Create raffle: ${query}`,
        description: "Add me to a group first, then use /newraffle",
        input_message_content: {
          message_text:
            `🎟 <b>${escapeHtml(query)}</b>\n\nTo create a raffle, add @${(await bot.api.getMe()).username} to your group and open the /newraffle setup wizard.`,
          parse_mode: "HTML" as const,
        },
      });
    }

    await ctx.answerInlineQuery(results, { cache_time: 10 });
  } catch (err) {
    console.error("Inline query error:", err);
  }
});

// --- Detect new members joining via referral invite links ---
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update) return;

  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;

  // Only trigger when someone joins (was not in, now is a member)
  const wasOut = oldStatus === "left" || oldStatus === "kicked";
  const isIn = newStatus === "member" || newStatus === "administrator";
  if (!wasOut || !isIn) return;

  // Check if the join was via an invite link
  const inviteLink = update.invite_link?.invite_link;
  if (!inviteLink) return;

  // Look up all active referral links matching this invite
  const referrals = db.getActiveReferralsByInviteLink(inviteLink);
  if (referrals.length === 0) return;

  const joinedUserId = update.new_chat_member.user.id;

  for (const ref of referrals) {
    // Don't award bonus if the referrer is the person joining
    if (ref.user_id === joinedUserId) continue;

    const raffle = db.getRaffleById(ref.raffle_id);
    if (!raffle || raffle.status !== "open") continue;

    // Check max referral cap
    if (raffle.max_referral_entries > 0 && ref.bonus_entries >= raffle.max_referral_entries) {
      continue; // Cap reached
    }

    // Award +1 bonus entry
    db.incrementBonusEntries(ref.id);

    // Refresh the raffle post to show updated entry count
    try {
      await refreshRaffleMessage(raffle);
    } catch {
      // Non-critical — will refresh on next countdown cycle
    }

    // Notify the referrer via DM
    const newBonus = ref.bonus_entries + 1;
    const joinerName = getUserDisplayName(
      update.new_chat_member.user.first_name,
      update.new_chat_member.user.last_name
    );
    try {
      const totalEntries = 1 + newBonus; // 1 base + bonus
      await bot.api.sendMessage(
        ref.user_id,
        `🔗 <b>+1 Bonus Entry!</b>\n\n` +
          `${escapeHtml(joinerName)} joined via your referral link for <b>${escapeHtml(raffle.title)}</b>.\n` +
          `You now have <b>${totalEntries}</b> total entr${totalEntries === 1 ? "y" : "ies"} (1 base + ${newBonus} referral).`,
        { parse_mode: "HTML" }
      );
    } catch {
      // Can't DM the referrer
    }
  }
});

// --- Owner notification when the bot is added to a group ---
async function notifyOwnerOfNewGroup(opts: {
  chatId: number;
  chatTitle: string;
  botStatus: "member" | "administrator";
  addedBy: { id: number; first_name?: string; last_name?: string; username?: string };
}): Promise<void> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0) return;

  const { chatId, chatTitle, botStatus, addedBy } = opts;

  // Determine first-time vs re-add by looking at raffle history for this chat.
  // bot_groups rows are deleted on kick, so it can't tell us "have we ever seen this chat".
  const { totalRaffles } = db.getGroupStats(chatId);
  const isReturning = totalRaffles > 0;

  const totalActiveGroups = db.getActiveBotGroups().length;

  const adderName = [addedBy.first_name, addedBy.last_name]
    .filter(Boolean)
    .join(" ") || "Unknown";
  const adderHandle = addedBy.username ? ` (@${escapeHtml(addedBy.username)})` : "";
  const statusIcon = botStatus === "administrator" ? "🛡 admin" : "👤 member";
  const headerIcon = isReturning ? "🔄" : "🆕";
  const headerLabel = isReturning ? "Bot re-added to group" : "Bot added to new group";

  const msg =
    `${headerIcon} <b>${headerLabel}</b>\n\n` +
    `<b>Group:</b> ${escapeHtml(chatTitle || "(no title)")}\n` +
    `<b>Chat ID:</b> <code>${chatId}</code>\n` +
    `<b>Bot status:</b> ${statusIcon}\n` +
    `<b>Added by:</b> ${escapeHtml(adderName)}${adderHandle}\n` +
    `<b>User ID:</b> <code>${addedBy.id}</code>\n` +
    (isReturning
      ? `<b>History:</b> ${totalRaffles} prior raffle${totalRaffles !== 1 ? "s" : ""} in this chat\n`
      : "") +
    `\n<i>Now tracking ${totalActiveGroups} active group${totalActiveGroups !== 1 ? "s" : ""}.</i>`;

  try {
    await bot.api.sendMessage(ownerId, msg, { parse_mode: "HTML" });
    console.log(
      `Owner notified of ${isReturning ? "re-add" : "new group"}: "${chatTitle}" (${chatId})`
    );
  } catch (err) {
    console.error(`Failed to DM owner about new group ${chatId}:`, err);
  }
}

// --- Welcome DM when bot is added to a new group ---
bot.on("my_chat_member", async (ctx) => {
  const update = ctx.myChatMember;
  if (!update) return;

  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const chatId = update.chat.id;
  const chatTitle = "title" in update.chat ? update.chat.title || "" : "";

  // Track bot's group membership
  if (newStatus === "administrator") {
    db.upsertBotGroup(chatId, chatTitle, "administrator");
    console.log(`Bot promoted to admin in "${chatTitle}" (${chatId})`);
  } else if (newStatus === "member") {
    db.upsertBotGroup(chatId, chatTitle, "member");
    console.log(`Bot is member in "${chatTitle}" (${chatId})`);
  } else if (newStatus === "left" || newStatus === "kicked") {
    // Before removing, check if there are active or unannounced raffles tied to this chat
    const stillActive = db.countActiveOrUnannouncedInChat(chatId);

    // Capture WHO removed the bot and HOW, so the owner can tell whether it
    // was an intentional admin action vs. the group being deleted/migrated.
    const actor = update.from;
    const actorName =
      [actor?.first_name, actor?.last_name].filter(Boolean).join(" ") || "Unknown";
    const actorHandle = actor?.username ? ` (@${actor.username})` : "";
    const actorId = actor?.id;
    // "kicked" = banned/removed by an admin; "left" = removed without ban,
    // or the bot left, or the group was deleted/migrated.
    const removalType =
      newStatus === "kicked"
        ? "banned/removed by an admin"
        : "removed (or group deleted/migrated)";

    db.removeBotGroup(chatId);
    console.log(
      `Bot removed from "${chatTitle}" (${chatId}) — ${oldStatus}→${newStatus}, by ${actorName}${actorHandle} [${actorId ?? "?"}]`
    );

    // Notify the owner about every removal (not just ones with active raffles),
    // so you always know when/why the bot leaves a group.
    const raffleLine =
      stillActive > 0
        ? `\n⚠️ <b>${stillActive} active/unannounced raffle${stillActive !== 1 ? "s" : ""}</b> — will be marked failed within ${ANNOUNCEMENT_GIVE_UP_HOURS}h. Use /health to review.`
        : "";
    notifyOwner(
      `🚪 <b>Bot left a group</b>\n\n` +
        `<b>Group:</b> ${escapeHtml(chatTitle || "(no title)")}\n` +
        `<b>Chat ID:</b> <code>${chatId}</code>\n` +
        `<b>How:</b> ${removalType}\n` +
        `<b>By:</b> ${escapeHtml(actorName)}${escapeHtml(actorHandle)}\n` +
        `<b>User ID:</b> <code>${actorId ?? "unknown"}</code>` +
        raffleLine
    ).catch(() => {});
  }

  // Only send welcome when bot was NOT in the group and is now a member/admin
  const wasOut = oldStatus === "left" || oldStatus === "kicked";
  const isIn = newStatus === "member" || newStatus === "administrator";
  if (!wasOut || !isIn) return;

  const addedBy = update.from;
  if (!addedBy) return;

  console.log(
    `Bot added to group "${chatTitle}" (${chatId}) by user ${addedBy.id} (${addedBy.first_name})`
  );

  // DM the bot owner so they hear about every group join in real time.
  // Best-effort — failure here must not block the welcome DM below.
  notifyOwnerOfNewGroup({
    chatId,
    chatTitle,
    botStatus: newStatus,
    addedBy,
  }).catch((err) =>
    console.error(`Failed to notify owner of new group ${chatId}:`, err)
  );

  // Build the welcome / feature overview message
  const welcomeMsg =
    `🎟 <b>Thanks for adding Raffle Bot to ${escapeHtml(chatTitle)}!</b>\n\n` +
    `Here's everything I can do:\n\n` +
    `<b>🎰 Raffle Creation</b>\n` +
    `• Interactive wizard — step-by-step in your DMs\n` +
    `• Multiple prizes per raffle (1st, 2nd, 3rd place)\n` +
    `• Custom banner images per raffle\n` +
    `• Delayed start & auto-close timers\n` +
    `• Sponsor attribution on raffle posts\n\n` +
    `<b>🏆 Drawing & Winners</b>\n` +
    `• Animated wheel spin before revealing winners\n` +
    `• Auto-draw when timer expires or max entries reached\n` +
    `• Live countdown on raffle posts (updates every minute)\n` +
    `• 5-minute "ending soon" reminders\n` +
    `• Winners & creator notified via DM\n\n` +
    `<b>📋 Templates & Recurring</b>\n` +
    `• Save raffle configs as reusable templates\n` +
    `• One-tap private template hub\n` +
    `• Recurring raffles on a schedule (hourly, daily, weekly)\n\n` +
    `<b>🛡 Entry Verification</b>\n` +
    `• Require Telegram username\n` +
    `• Minimum account age filter\n` +
    `• Winner cooldown (exclude recent winners)\n\n` +
    `<b>📊 Management Tools</b>\n` +
    `• Edit active raffles live\n` +
    `• Re-run past raffles with the same participants\n` +
    `• Export participant lists as CSV\n` +
    `• View group statistics and raffle history\n\n` +
    `<b>🌐 Multi-Language</b>\n` +
    `• English, Español, Português, Русский, Français, Deutsch\n` +
    `• Change it privately from the Admin Center\n\n` +
    `<b>🚀 Get started:</b> Open my private chat, choose Admin Center, then select ${escapeHtml(chatTitle)}. All setup and management stays out of the group chat.`;

  // Try to DM the person who added the bot
  try {
    await ctx.api.sendMessage(addedBy.id, welcomeMsg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Open Admin Center", "admin_groups"),
    });
  } catch {
    // User hasn't started a DM with the bot — can't message them.
    // That's fine, they'll discover features via /help.
    console.log(
      `Could not DM user ${addedBy.id} (${addedBy.first_name}) — they haven't started the bot.`
    );
  }
});

// --- Error handling ---
bot.catch((err) => {
  const errObj = err as unknown as Record<string, unknown>;
  const innerErr = errObj?.error as Record<string, unknown> | undefined;
  const msg =
    innerErr?.description ?? errObj?.message ?? String(err);
  // Silently ignore stale callback queries (buttons pressed during restart)
  if (typeof msg === "string" && msg.includes("query is too old")) return;
  console.error("Bot error:", err);
});

// --- Seed bot_groups on startup ---

// Refresh a group's title and bot status. NEVER removes groups —
// if we can't reach the group, we just skip it and keep the old data.
// Groups are only removed via the my_chat_member handler when the bot is explicitly kicked.
async function refreshGroup(
  botId: number,
  chatId: number,
  title: string
): Promise<"refreshed" | "skipped"> {
  try {
    const chat = await bot.api.getChat(chatId) as unknown as Record<string, unknown>;
    const chatTitle = chat.title ? String(chat.title) : title;
    const member = await bot.api.getChatMember(chatId, botId);
    if (member.status === "administrator" || member.status === "member") {
      db.upsertBotGroup(chatId, chatTitle, member.status);
      return "refreshed";
    }
    // Bot was kicked/left but don't remove — keep historical record
    return "skipped";
  } catch {
    // API error (rate limit, timeout, network) — keep the group as-is
    return "skipped";
  }
}

async function seedBotGroups(): Promise<void> {
  const botId = bot.botInfo.id;

  const existing = db.getActiveBotGroups();
  if (existing.length > 0) {
    console.log(`Refreshing ${existing.length} tracked groups...`);
    // Process in batches of 3 with a delay between batches to respect rate limits
    const BATCH_SIZE = 3;
    for (let i = 0; i < existing.length; i += BATCH_SIZE) {
      await Promise.all(
        existing.slice(i, i + BATCH_SIZE).map((g) => refreshGroup(botId, g.chat_id, g.title))
      );
      if (i + BATCH_SIZE < existing.length) {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    // Also check for groups in raffle history that aren't tracked yet (recovery)
    const allKnownChatIds = db.getAllGroupChatIds();
    const trackedIds = new Set(existing.map((g) => g.chat_id));
    const missingIds = allKnownChatIds.filter((id) => !trackedIds.has(id));
    if (missingIds.length > 0) {
      console.log(`Recovering ${missingIds.length} untracked groups from raffle history...`);
      let recovered = 0;
      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        const results = await Promise.all(
          missingIds.slice(i, i + BATCH_SIZE).map((id) => refreshGroup(botId, id, ""))
        );
        recovered += results.filter((r) => r === "refreshed").length;
        if (i + BATCH_SIZE < missingIds.length) {
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      if (recovered > 0) console.log(`Recovered ${recovered} groups`);
    }

    const after = db.getActiveBotGroups();
    console.log(`Group refresh complete: ${after.length} active groups`);
    return;
  }

  // First run — seed from raffle history
  const chatIds = db.getAllGroupChatIds();
  if (chatIds.length === 0) return;

  console.log(`Seeding bot_groups from ${chatIds.length} known groups...`);
  let added = 0;
  const BATCH_SIZE = 3;
  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    const results = await Promise.all(
      chatIds.slice(i, i + BATCH_SIZE).map((id) => refreshGroup(botId, id, ""))
    );
    added += results.filter((r) => r === "refreshed").length;
    if (i + BATCH_SIZE < chatIds.length) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  console.log(`Seeded ${added} active groups (${chatIds.length - added} skipped)`);
}

// --- Start bot ---
async function main(): Promise<void> {
  // Admin/stats HTTP endpoint for the control tower (mode-independent).
  startAdminServer();

  // Group chats expose useful launch commands, while private navigation stays
  // button-based. Admin scope overrides the shorter member command list.
  await bot.api.deleteMyCommands();
  await bot.api.deleteMyCommands({ scope: { type: "all_group_chats" } });
  await bot.api.deleteMyCommands({ scope: { type: "all_chat_administrators" } });
  await bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } });
  await bot.api.setMyCommands(GROUP_MEMBER_COMMANDS, {
    scope: { type: "all_group_chats" },
  });
  await bot.api.setMyCommands(GROUP_ADMIN_COMMANDS, {
    scope: { type: "all_chat_administrators" },
  });

  // Initialize bot info (needed for bot.botInfo.id before bot.start())
  await bot.init();

  // --- Register persistent-job handlers ---
  // These handlers close over the bot instance, so they have to register here
  // (after bot.init) rather than at module load.
  registerHandler("revoke_referrals", async (payload) => {
    const { raffleId } = payload as { raffleId: number };
    await revokeReferralInviteLinks(bot.api, raffleId);
  });

  registerHandler("notify_winners", async (payload) => {
    const { raffleId } = payload as { raffleId: number };
    const raffle = db.getRaffleById(raffleId);
    if (!raffle) {
      throw new Error(`Raffle ${raffleId} not found`);
    }
    const winners = db.getWinnersForRaffle(raffleId);
    await notifyWinnersAndCreator(bot.api, raffle, winners);
  });

  // Recover any jobs that were 'running' when the bot was last killed.
  const recoveredCount = recoverOrphanedJobs();
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} orphaned job(s) from previous run`);
  }

  // Start the job worker — polls for pending jobs every 5 seconds
  setInterval(makeNonOverlapping(processJobs, "processJobs"), 5_000);
  // Purge completed jobs older than 7 days once an hour
  setInterval(() => purgeOldJobs(7), 60 * 60 * 1000);
  console.log("Job queue worker active: polling every 5s, retention 7 days");

  // Refresh tracked groups without delaying Telegram polling during startup.
  void seedBotGroups().catch((err) => {
    console.error("Background group refresh failed:", err);
  });

  // Start expiry checker (with re-entry guard)
  setInterval(makeNonOverlapping(checkExpiredRaffles, "checkExpiredRaffles"), EXPIRY_CHECK_INTERVAL);

  // Start countdown refresh (with re-entry guard)
  setInterval(makeNonOverlapping(refreshCountdowns, "refreshCountdowns"), COUNTDOWN_REFRESH_INTERVAL);
  console.log("Countdown refresh active: every 60s");

  // Start automated backups + WAL checkpoints (with re-entry guard)
  walCheckpoint(); // Run once on startup to clean up any pending WAL
  setInterval(makeNonOverlapping(walCheckpoint, "walCheckpoint"), WAL_CHECKPOINT_INTERVAL_MS);
  console.log(`WAL checkpoints active: every ${WAL_CHECKPOINT_INTERVAL_MS / 1000}s`);

  // External uptime heartbeat (configured via HEARTBEAT_URL env var)
  startHeartbeat();

  backupDatabase(); // Run once on startup
  setInterval(makeNonOverlapping(backupDatabase, "backupDatabase"), BACKUP_INTERVAL_MS);
  console.log(`Automated backups active: every ${BACKUP_INTERVAL_MS / 60000}min, retention ${BACKUP_RETENTION} files`);

  // Start recurring template checker (with re-entry guard)
  setInterval(makeNonOverlapping(checkRecurringTemplates, "checkRecurringTemplates"), RECURRING_CHECK_INTERVAL);

  // Start data retention purge (with re-entry guard)
  purgeOldData();
  setInterval(makeNonOverlapping(purgeOldData, "purgeOldData"), PURGE_CHECK_INTERVAL);

  // Weekly stats report to bot owner
  const WEEKLY_REPORT_INTERVAL = 60_000; // check every minute
  let lastWeeklyReport = 0;

  async function checkWeeklyReport(): Promise<void> {
    const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
    if (ownerId === 0) return;

    const now = new Date();
    // Send every Monday at 9:00 AM UTC
    if (now.getUTCDay() !== 1) return; // Not Monday
    if (now.getUTCHours() !== 9 || now.getUTCMinutes() !== 0) return; // Not 9:00

    // Prevent duplicate sends within the same minute
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === lastWeeklyReport) return;
    lastWeeklyReport = minuteKey;

    try {
      const msg = `📬 <b>Weekly Report</b>\n\n` + buildStatsMessage();
      await bot.api.sendMessage(ownerId, msg, { parse_mode: "HTML" });
      console.log("Weekly stats report sent to owner");
    } catch (err) {
      console.error("Failed to send weekly report:", err);
    }
  }
  setInterval(makeNonOverlapping(checkWeeklyReport, "checkWeeklyReport"), WEEKLY_REPORT_INTERVAL);

  // Daily new-raffle digest to bot owner
  const DAILY_DIGEST_INTERVAL = 60_000; // check every minute
  let lastDailyDigest = 0;

  async function checkDailyDigest(): Promise<void> {
    const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
    if (ownerId === 0) return;

    const now = new Date();
    // Send every day at 21:00 UTC (4 PM EST / 5 PM EDT)
    if (now.getUTCHours() !== 21 || now.getUTCMinutes() !== 0) return;

    // Prevent duplicate sends within the same minute
    const minuteKey = Math.floor(now.getTime() / 60_000);
    if (minuteKey === lastDailyDigest) return;
    lastDailyDigest = minuteKey;

    // Get raffles created in the last 24 hours
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sinceUtc = since.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    const newRaffles = db.getRafflesCreatedSince(sinceUtc);

    if (newRaffles.length === 0) return; // Nothing to report

    const groups = db.getActiveBotGroups();
    const groupMap = new Map(groups.map((g) => [g.chat_id, g.title]));

    let msg = `📋 <b>Daily Raffle Digest</b>\n\n`;
    msg += `<b>${newRaffles.length}</b> new raffle${newRaffles.length !== 1 ? "s" : ""} created today:\n\n`;

    for (const r of newRaffles) {
      const groupName = groupMap.get(r.chat_id) || `Chat ${r.chat_id}`;
      const status = r.status === "open" ? "🟢" : r.status === "drawn" ? "🏆" : "🔴";
      msg += `${status} <b>${escapeHtml(r.title)}</b>\n`;
      msg += `   👤 ${escapeHtml(r.creator_name)} · 💬 ${escapeHtml(groupName)}\n`;
    }

    try {
      await bot.api.sendMessage(ownerId, msg, { parse_mode: "HTML" });
      console.log(`Daily digest sent: ${newRaffles.length} new raffle(s)`);
    } catch (err) {
      console.error("Failed to send daily digest:", err);
    }
  }
  setInterval(makeNonOverlapping(checkDailyDigest, "checkDailyDigest"), DAILY_DIGEST_INTERVAL);

  console.log("Raffle Bot is running! Press Ctrl+C to stop.");

  const allowedUpdates = [
    "message",
    "callback_query",
    "inline_query",
    "my_chat_member",
    "chat_member",
  ] as const;

  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET || "";
  const webhookPort = parseInt(process.env.WEBHOOK_PORT || "3001", 10);

  if (webhookUrl) {
    // --- Webhook mode ---
    // Telegram pushes updates to our public URL instead of us polling.
    // Lower latency, less bandwidth, scales further. Requires:
    //   - WEBHOOK_URL: public HTTPS URL routed to this container
    //   - WEBHOOK_SECRET: random token to validate incoming requests
    //   - WEBHOOK_PORT: container port to listen on (default 3001)
    //   - The container must expose this port AND a tunnel/proxy must
    //     route the public URL to it.
    logger.info({ url_host: new URL(webhookUrl).host, port: webhookPort }, "Starting in webhook mode");

    // Delete any existing polling-mode state, then register our endpoint
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    await bot.api.setWebhook(webhookUrl, {
      secret_token: webhookSecret || undefined,
      allowed_updates: [...allowedUpdates],
      drop_pending_updates: false,
    });
    logger.info({}, "Webhook registered with Telegram");

    const handleUpdate = webhookCallback(bot, "http", {
      secretToken: webhookSecret || undefined,
    });

    const server = http.createServer(async (req, res) => {
      // Only handle POST to /webhook
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404).end();
        return;
      }
      try {
        await handleUpdate(req, res);
      } catch (err) {
        logger.error({ err }, "Webhook handler failed");
        if (!res.headersSent) res.writeHead(500).end();
      }
    });

    server.listen(webhookPort, () => {
      logger.info({ port: webhookPort }, "Webhook HTTP server listening");
    });

    const stopWebhook = async () => {
      logger.info({}, "Shutdown signal received, deleting webhook");
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: false });
      } catch {}
      server.close();
    };
    process.once("SIGINT", stopWebhook);
    process.once("SIGTERM", stopWebhook);
  } else {
    // --- Polling mode (default) ---
    // grammY runner handles concurrent update processing.
    // sequentialize middleware ensures same-chat ordering; different chats run concurrently.
    const runner = run(bot, {
      runner: {
        fetch: {
          allowed_updates: [...allowedUpdates],
        },
      },
    });

    const stopRunner = () => runner.isRunning() && runner.stop();
    process.once("SIGINT", stopRunner);
    process.once("SIGTERM", stopRunner);
  }
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
