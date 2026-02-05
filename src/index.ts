import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { initDatabase } from "./database";
import * as db from "./database";
import {
  handleStart,
  handleHelp,
  handleNewRaffle,
  handleListRaffles,
  handleDraw,
  handleCancelRaffle,
  handleMyEntries,
  handleRaffleHistory,
  handleExportEntries,
  handleRerun,
  handleEnterCallback,
  handleLeaveCallback,
  handleEntriesCallback,
  handleSaveTemplate,
  handleTemplates,
  handleDeleteTemplate,
  handleUseTemplate,
  handleRecurring,
  handleEditRaffle,
  handleLanguage,
  handleStats,
  notifyWinnersAndCreator,
} from "./commands";
import {
  formatRaffleMessage,
  formatWinnersMessage,
  escapeHtml,
  getUserDisplayName,
  sleep,
  performWheelSpin,
} from "./helpers";
import type { Raffle } from "./types";
import { t } from "./i18n";
import {
  handleWizardMessage,
  handleWizardPhoto,
  handleWinnersCallback,
  handleTimeCallback,
  handleOptionsCallback,
  handleStartDeepLink,
  getActiveWizard,
  handleEditCallback,
  handleEditTextMessage,
  getActiveEditWizard,
  startEditWizard,
} from "./wizard";

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
if (DATA_RETENTION_HOURS > 0) {
  console.log(
    `Data retention: completed raffle data will be purged after ${DATA_RETENTION_HOURS} hours`
  );
} else {
  console.log(`Data retention: disabled (data kept indefinitely)`);
}

// Create bot
const bot = new Bot(BOT_TOKEN);

// --- Auto-delete command messages in group chats ---
bot.use(async (ctx, next) => {
  const isGroup =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
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

// --- Register commands ---
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("newraffle", handleNewRaffle);
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
bot.command("stats", handleStats);

// --- Register callback queries ---
bot.callbackQuery(/^enter_\d+$/, handleEnterCallback);
bot.callbackQuery(/^leave_\d+$/, handleLeaveCallback);
bot.callbackQuery(/^entries_\d+$/, handleEntriesCallback);

// --- Wizard callback queries ---
bot.callbackQuery(/^wiz_winners_\d+$/, handleWinnersCallback);
bot.callbackQuery(/^wiz_time_/, handleTimeCallback);
bot.callbackQuery(/^wiz_opt_/, handleOptionsCallback);

// --- Edit wizard callback queries ---
bot.callbackQuery(/^edit_/, handleEditCallback);

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

  // Check if user has an active creation wizard
  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardMessage(ctx);
});

// --- Handle photo messages (for wizard image upload in DMs) ---
bot.on("message:photo", async (ctx) => {
  if (!ctx.from) return;
  if (ctx.chat.type !== "private") return;

  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardPhoto(ctx);
});

// --- Auto-draw expired raffles ---
const EXPIRY_CHECK_INTERVAL = 30_000; // 30 seconds

async function checkExpiredRaffles(): Promise<void> {
  try {
    const expired = db.getExpiredOpenRaffles();
    for (const raffle of expired) {
      console.log(`Auto-drawing expired raffle: ${raffle.id} - ${raffle.title}`);

      const entryCount = db.getEntryCount(raffle.id);

      const lang = db.getChatLanguage(raffle.chat_id);

      if (entryCount === 0) {
        try {
          await bot.api.sendMessage(
            raffle.chat_id,
            `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n⏰ Raffle ended. ${t(lang, "winner.no_entries")}`,
            { parse_mode: "HTML" }
          );
          db.markRaffleDrawn(raffle.id);
        } catch (err) {
          console.error(`Failed to announce empty raffle ${raffle.id}, will retry:`, err);
          continue; // Leave as "open" so it retries next check
        }
      } else {
        const entries = db.getEntriesForRaffle(raffle.id);
        const entryNames = entries.map((e) => e.user_display_name);
        const winners = db.selectWinners(raffle.id);

        // Only show wheel spin if raffle expired recently (within 2 minutes)
        const expiredAt = new Date(raffle.ends_at + "Z");
        const staleness = Date.now() - expiredAt.getTime();
        const isRecent = staleness < 2 * 60 * 1000;

        let announced = false;

        if (isRecent && entryNames.length >= 2) {
          try {
            const spinMsgId = await performWheelSpin(
              bot.api,
              raffle.chat_id,
              entryNames,
              raffle.title,
              lang
            );
            await sleep(1000);
            try {
              await bot.api.editMessageText(
                raffle.chat_id,
                spinMsgId,
                formatWinnersMessage(raffle, winners, lang),
                { parse_mode: "HTML" }
              );
            } catch {
              await bot.api.sendMessage(
                raffle.chat_id,
                formatWinnersMessage(raffle, winners, lang),
                { parse_mode: "HTML" }
              );
            }
            announced = true;
          } catch {
            // Wheel spin failed, try direct announcement
            try {
              await bot.api.sendMessage(
                raffle.chat_id,
                formatWinnersMessage(raffle, winners, lang),
                { parse_mode: "HTML" }
              );
              announced = true;
            } catch (err) {
              console.error(`Failed to announce raffle ${raffle.id}, will retry:`, err);
            }
          }
        } else {
          try {
            await bot.api.sendMessage(
              raffle.chat_id,
              formatWinnersMessage(raffle, winners, lang),
              { parse_mode: "HTML" }
            );
            announced = true;
          } catch (err) {
            console.error(`Failed to announce raffle ${raffle.id}, will retry:`, err);
          }
        }

        if (!announced) {
          continue; // Leave as "open" so it retries next check
        }

        // Mark as drawn only after successful announcement
        db.markRaffleDrawn(raffle.id);

        // DM winners and creator
        await notifyWinnersAndCreator(bot.api, raffle, winners);
      }

      // Update the original raffle post
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

            await bot.api.editMessageText(
              raffle.chat_id,
              raffle.message_id,
              text,
              { parse_mode: "HTML" }
            );
          }
        } catch {
          // Message may be too old or deleted
        }
      }
    }
  } catch (err) {
    console.error("Error checking expired raffles:", err);
  }
}

// --- Refresh countdowns on active raffle posts ---
const COUNTDOWN_REFRESH_INTERVAL = 60_000; // 1 minute
const COUNTDOWN_FAST_INTERVAL = 1_000; // 1 second for final 30s
const COUNTDOWN_FAST_THRESHOLD = 30_000; // 30 seconds

let fastTickerActive = false;
let fastTickerInterval: ReturnType<typeof setInterval> | null = null;

async function refreshRaffleMessage(raffle: Raffle): Promise<void> {
  if (!raffle.message_id) return;

  const count = db.getEntryCount(raffle.id);
  const lang = db.getChatLanguage(raffle.chat_id);

  const keyboard = new InlineKeyboard()
    .text(`🎟 ${t(lang, "btn.enter")}`, `enter_${raffle.id}`)
    .text(`❌ ${t(lang, "btn.leave")}`, `leave_${raffle.id}`)
    .row()
    .text(`👥 ${t(lang, "btn.entries", { count })}`, `entries_${raffle.id}`);

  try {
    await bot.api.editMessageText(
      raffle.chat_id,
      raffle.message_id,
      formatRaffleMessage(raffle, count, lang),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  } catch {
    // Message unchanged or deleted — ignore
  }
}

async function refreshCountdowns(): Promise<void> {
  try {
    const raffles = db.getOpenRafflesWithEndTime();
    if (raffles.length > 0) {
      console.log(`Refreshing countdown for ${raffles.length} active raffle(s)`);
    }
    let hasUrgent = false;

    for (const raffle of raffles) {
      const endsAt = new Date(raffle.ends_at + "Z");
      const remaining = endsAt.getTime() - Date.now();

      if (remaining > COUNTDOWN_FAST_THRESHOLD) {
        // Normal refresh — update once per minute
        await refreshRaffleMessage(raffle);
      } else if (remaining > 0) {
        hasUrgent = true;
      }
    }

    // Start fast ticker if any raffles are in the final 30s
    if (hasUrgent && !fastTickerActive) {
      fastTickerActive = true;
      fastTickerInterval = setInterval(refreshFinalCountdowns, COUNTDOWN_FAST_INTERVAL);
    }
  } catch (err) {
    console.error("Error refreshing countdowns:", err);
  }
}

async function refreshFinalCountdowns(): Promise<void> {
  try {
    const raffles = db.getOpenRafflesWithEndTime();
    let stillUrgent = false;

    for (const raffle of raffles) {
      const endsAt = new Date(raffle.ends_at + "Z");
      const remaining = endsAt.getTime() - Date.now();

      if (remaining > 0 && remaining <= COUNTDOWN_FAST_THRESHOLD) {
        stillUrgent = true;
        await refreshRaffleMessage(raffle);
      }
    }

    // Stop fast ticker when no more urgent raffles
    if (!stillUrgent && fastTickerInterval) {
      clearInterval(fastTickerInterval);
      fastTickerInterval = null;
      fastTickerActive = false;
    }
  } catch (err) {
    console.error("Error in fast countdown refresh:", err);
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
    const dueTemplates = db.getDueRecurringTemplates();
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

      const raffle = db.createRaffle({
        chat_id: template.chat_id,
        creator_id: template.creator_id,
        creator_name: "Recurring Raffle",
        title: template.title,
        description: "",
        prize: template.prize,
        prizes: template.prizes,
        max_entries: template.max_entries,
        max_winners: template.max_winners,
        ends_at: endsAt,
        starts_at: null,
        required_chat_id: null,
        required_chat_title: null,
        sponsor_name: template.sponsor_name,
        anonymous: template.anonymous,
        image_file_id: null,
        auto_pin: 0,
      });

      try {
        const recLang = db.getChatLanguage(template.chat_id);
        const keyboard = new InlineKeyboard()
          .text(`🎟 ${t(recLang, "btn.enter")}`, `enter_${raffle.id}`)
          .text(`❌ ${t(recLang, "btn.leave")}`, `leave_${raffle.id}`)
          .row()
          .text(`👥 ${t(recLang, "btn.entries", { count: 0 })}`, `entries_${raffle.id}`);

        const msg = await bot.api.sendMessage(
          template.chat_id,
          formatRaffleMessage(raffle, 0, recLang),
          { parse_mode: "HTML", reply_markup: keyboard }
        );

        db.updateRaffleMessageId(raffle.id, msg.message_id);
      } catch (err) {
        console.error(`Failed to post recurring raffle for template ${template.id}:`, err);
      }

      // Schedule the next run
      const nextRun = new Date(Date.now() + template.recurring_interval_minutes! * 60 * 1000);
      const nextRunStr = nextRun
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
        .split(".")[0];
      db.updateNextRunAt(template.id, nextRunStr);
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
            `🎟 <b>${escapeHtml(query)}</b>\n\nTo create this raffle, add @${(await bot.api.getMe()).username} to your group and use:\n<code>/newraffle ${escapeHtml(query)}</code>`,
          parse_mode: "HTML" as const,
        },
      });
    }

    await ctx.answerInlineQuery(results, { cache_time: 10 });
  } catch (err) {
    console.error("Inline query error:", err);
  }
});

// --- Error handling ---
bot.catch((err) => {
  console.error("Bot error:", err);
});

// --- Start bot ---
async function main(): Promise<void> {
  // Set bot commands for the menu
  await bot.api.setMyCommands([
    { command: "newraffle", description: "Create a new raffle" },
    { command: "raffles", description: "List open raffles" },
    { command: "draw", description: "Draw winners for a raffle" },
    { command: "cancelraffle", description: "Cancel a raffle" },
    { command: "myentries", description: "See your active entries" },
    { command: "rafflehistory", description: "View past raffles" },
    { command: "exportentries", description: "Export participant list" },
    { command: "rerun", description: "Re-run a raffle with same participants" },
    { command: "savetemplate", description: "Save a reusable raffle template" },
    { command: "templates", description: "List saved templates" },
    { command: "usetemplate", description: "Create raffle from template" },
    { command: "recurring", description: "Toggle recurring raffles" },
    { command: "editraffle", description: "Edit an active raffle" },
    { command: "language", description: "Set bot language" },
    { command: "help", description: "Show help message" },
  ]);

  // Start expiry checker
  setInterval(checkExpiredRaffles, EXPIRY_CHECK_INTERVAL);

  // Start countdown refresh
  setInterval(refreshCountdowns, COUNTDOWN_REFRESH_INTERVAL);
  console.log("Countdown refresh active: every 60s, per-second in final 30s");

  // Start recurring template checker
  setInterval(checkRecurringTemplates, RECURRING_CHECK_INTERVAL);

  // Start data retention purge (run once at startup, then hourly)
  purgeOldData();
  setInterval(purgeOldData, PURGE_CHECK_INTERVAL);

  console.log("Raffle Bot is running! Press Ctrl+C to stop.");
  await bot.start();
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
