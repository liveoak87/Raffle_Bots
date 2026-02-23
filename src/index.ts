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
  handleCancelCallback,
  handleRepostCallback,
  handleMyEntries,
  handleRaffleHistory,
  handleExportEntries,
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
  handleStats,
  handleGroupStats,
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
  sleep,
  notifyOwnerNewRaffle,
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
  getActiveTemplateWizard,
  handleTemplateWizardMessage,
  handleTmplWinnersCallback,
  handleTmplTimeCallback,
  handleTmplOptionsCallback,
  getActiveBugReport,
  handleBugReportMessage,
  handleBugReportPhoto,
  handleBugReportSkip,
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
bot.command("groupstats", handleGroupStats);
bot.command("bugreport", handleBugReport);

// --- Register callback queries ---
bot.callbackQuery(/^enter_\d+$/, handleEnterCallback);
bot.callbackQuery(/^leave_\d+$/, handleLeaveCallback);
bot.callbackQuery(/^entries_\d+(_\d+)?$/, handleEntriesCallback);

// --- Wizard callback queries ---
bot.callbackQuery(/^wiz_winners_\d+$/, handleWinnersCallback);
bot.callbackQuery(/^wiz_time_/, handleTimeCallback);
bot.callbackQuery(/^wiz_opt_/, handleOptionsCallback);

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

// --- Template wizard callback queries ---
bot.callbackQuery(/^twiz_winners_\d+$/, handleTmplWinnersCallback);
bot.callbackQuery(/^twiz_time_/, handleTmplTimeCallback);
bot.callbackQuery(/^twiz_opt_/, handleTmplOptionsCallback);

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

  // Raffle wizard image
  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardPhoto(ctx);
});

// --- Auto-draw expired raffles ---
const EXPIRY_CHECK_INTERVAL = 10_000; // 10 seconds - check more frequently for quicker auto-draw

async function checkExpiredRaffles(): Promise<void> {
  try {
    const expired = db.getExpiredOpenRaffles();
    for (const raffle of expired) {
      console.log(`Auto-drawing expired raffle: ${raffle.id} - ${raffle.title}`);

      // Mark as drawn IMMEDIATELY to prevent double-processing
      db.markRaffleDrawn(raffle.id);
      await revokeReferralInviteLinks(bot.api, raffle.id);

      const entryCount = db.getEntryCount(raffle.id);
      const lang = db.getChatLanguage(raffle.chat_id);

      if (entryCount === 0) {
        try {
          await bot.api.sendMessage(
            raffle.chat_id,
            `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n⏰ Raffle ended. ${t(lang, "winner.no_entries")}`,
            { parse_mode: "HTML" }
          );
        } catch (err) {
          console.error(`Failed to announce empty raffle ${raffle.id}:`, err);
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
          await sendWheelSpin(bot.api, raffle.chat_id);
        }

        // Announce winners with embedded "WINNERS DRAWN" banner
        await sendWinnerPost(bot.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang));

        // DM winners and creator
        await notifyWinnersAndCreator(bot.api, raffle, winners);
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
  } catch (err) {
    console.error("Error checking expired raffles:", err);
  }
}

// --- Refresh countdowns on active raffle posts ---
const COUNTDOWN_REFRESH_INTERVAL = 60_000; // 1 minute
const ENDING_SOON_THRESHOLD = 5 * 60 * 1000; // 5 minutes
const endingSoonSent = new Set<number>(); // raffle IDs that already got a reminder

async function refreshRaffleMessage(raffle: Raffle): Promise<void> {
  if (!raffle.message_id) return;

  const count = db.getEntryCount(raffle.id);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffle.id) : count;
  const lang = db.getChatLanguage(raffle.chat_id);
  const botUsername = bot.botInfo.username;

  const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);

  try {
    // Try editMessageCaption first (for photo messages with embedded banner)
    await bot.api.editMessageCaption(
      raffle.chat_id,
      raffle.message_id,
      { caption: formatRaffleMessage(raffle, count, lang), parse_mode: "HTML", reply_markup: keyboard }
    );
  } catch {
    // Fallback to editMessageText (for old text-only messages without banner)
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
        try {
          await bot.api.sendMessage(
            raffle.chat_id,
            `⏰ <b>${escapeHtml(raffle.title)}</b> ends in ${mins} minute${mins > 1 ? "s" : ""}! ` +
              `${entryCount} entr${entryCount === 1 ? "y" : "ies"} so far — Don't miss out!`,
            {
              parse_mode: "HTML",
              reply_parameters: raffle.message_id ? { message_id: raffle.message_id } : undefined
            }
          );
        } catch {
          // Couldn't send reminder — not critical
        }
      }

      // Smart refresh: only update if enough time has passed based on remaining time
      if (remaining > 0) {
        const lastRefresh = lastRefreshTime.get(raffle.id) || 0;
        const refreshInterval = getRefreshInterval(remaining);
        const timeSinceLastRefresh = now - lastRefresh;

        if (timeSinceLastRefresh >= refreshInterval) {
          await refreshRaffleMessage(raffle);
          lastRefreshTime.set(raffle.id, now);
          refreshedCount++;
        }
      } else {
        // Clean up tracking for ended raffles
        lastRefreshTime.delete(raffle.id);
      }
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
        min_account_age_days: 0,
        require_username: 0,
        winner_cooldown: 0,
        show_animation: 1,
        referral_enabled: 0,
        max_referral_entries: 0,
        revoke_referral_links: 0,
      });

      try {
        const recLang = db.getChatLanguage(template.chat_id);
        const botUsername = bot.botInfo.username;

        const keyboard = buildRaffleKeyboard(raffle, 0, recLang, botUsername);

        const msgId = await sendRafflePost(
          bot.api,
          template.chat_id,
          "open",
          formatRaffleMessage(raffle, 0, recLang),
          keyboard
        );

        if (msgId) {
          db.updateRaffleMessageId(raffle.id, msgId);
        }

        await notifyOwnerNewRaffle(bot.api, raffle);
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
    db.removeBotGroup(chatId);
    console.log(`Bot removed from "${chatTitle}" (${chatId})`);
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

  // Build the welcome / feature overview message
  const welcomeMsg =
    `🎟 <b>Thanks for adding Raffle Bot to ${escapeHtml(chatTitle)}!</b>\n\n` +
    `Here's everything I can do:\n\n` +
    `<b>🎰 Raffle Creation</b>\n` +
    `• Interactive wizard — step-by-step in your DMs\n` +
    `• Quick inline: <code>/newraffle Title | Prize | ends:2h</code>\n` +
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
    `• One-tap template hub: /templates\n` +
    `• Recurring raffles on a schedule (hourly, daily, weekly)\n\n` +
    `<b>🛡 Entry Verification</b>\n` +
    `• Require Telegram username\n` +
    `• Minimum account age filter\n` +
    `• Winner cooldown (exclude recent winners)\n\n` +
    `<b>📊 Management Tools</b>\n` +
    `• /editraffle — edit active raffles live\n` +
    `• /rerun — re-run a past raffle with same participants\n` +
    `• /exportentries — export participant list as CSV\n` +
    `• /groupstats — view raffle stats for your group\n` +
    `• /rafflehistory — browse past raffles\n\n` +
    `<b>🌐 Multi-Language</b>\n` +
    `• English, Español, Português, Русский, Français, Deutsch\n` +
    `• Set with /language\n\n` +
    `<b>🚀 Get started:</b> Type /newraffle in ${escapeHtml(chatTitle)} to create your first raffle!\n\n` +
    `Questions or bugs? Use /bugreport to send feedback.`;

  // Try to DM the person who added the bot
  try {
    await ctx.api.sendMessage(addedBy.id, welcomeMsg, { parse_mode: "HTML" });
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
  console.error("Bot error:", err);
});

// --- Seed bot_groups on startup ---
async function seedBotGroups(): Promise<void> {
  const botId = bot.botInfo.id;

  const existing = db.getActiveBotGroups();
  if (existing.length > 0) {
    // Already seeded — refresh titles and status
    console.log(`Refreshing ${existing.length} tracked groups...`);
    let refreshed = 0;
    for (const group of existing) {
      try {
        const chat = await bot.api.getChat(group.chat_id) as unknown as Record<string, unknown>;
        const title = chat.title ? String(chat.title) : "";
        await sleep(100);
        const member = await bot.api.getChatMember(group.chat_id, botId);
        if (member.status === "administrator") {
          db.upsertBotGroup(group.chat_id, title, "administrator");
          refreshed++;
        } else if (member.status === "member") {
          db.upsertBotGroup(group.chat_id, title, "member");
          refreshed++;
        } else {
          db.removeBotGroup(group.chat_id);
          console.log(`  Removed: ${group.title} (status: ${member.status})`);
        }
      } catch (err) {
        db.removeBotGroup(group.chat_id);
        console.log(`  Removed: ${group.title} — unreachable`);
      }
      await sleep(500);
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
  let skipped = 0;
  for (const chatId of chatIds) {
    try {
      const chat = await bot.api.getChat(chatId) as unknown as Record<string, unknown>;
      const title = chat.title ? String(chat.title) : "";
      await sleep(100);
      const member = await bot.api.getChatMember(chatId, botId);
      if (member.status === "administrator") {
        db.upsertBotGroup(chatId, title, "administrator");
        added++;
        console.log(`  Added: ${title} (admin)`);
      } else if (member.status === "member") {
        db.upsertBotGroup(chatId, title, "member");
        added++;
        console.log(`  Added: ${title} (member)`);
      } else {
        skipped++;
      }
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      // Only log non-obvious errors (skip "chat not found")
      if (!msg.includes("chat not found")) {
        console.log(`  Skip: chat ${chatId} — ${msg}`);
      }
    }
    await sleep(500);
  }
  console.log(`Seeded ${added} active groups (${skipped} skipped)`);
}

// --- Start bot ---
async function main(): Promise<void> {
  // Set bot commands for the menu
  await bot.api.setMyCommands([
    { command: "newraffle", description: "Create a new raffle" },
    { command: "raffles", description: "List open raffles" },
    { command: "draw", description: "Draw winners" },
    { command: "templates", description: "Manage raffle templates" },
    { command: "editraffle", description: "Edit an active raffle" },
    { command: "cancelraffle", description: "Cancel a raffle" },
    { command: "rerun", description: "Re-run a past raffle" },
    { command: "exportentries", description: "Export participant list" },
    { command: "myentries", description: "See your active entries" },
    { command: "rafflehistory", description: "View past raffles" },
    { command: "groupstats", description: "View group raffle stats" },
    { command: "bugreport", description: "Report a bug" },
    { command: "language", description: "Set bot language" },
    { command: "help", description: "Show help" },
  ]);

  // Initialize bot info (needed for bot.botInfo.id before bot.start())
  await bot.init();

  // Seed bot_groups table from known groups (one-time on startup)
  await seedBotGroups();

  // Start expiry checker
  setInterval(checkExpiredRaffles, EXPIRY_CHECK_INTERVAL);

  // Start countdown refresh
  setInterval(refreshCountdowns, COUNTDOWN_REFRESH_INTERVAL);
  console.log("Countdown refresh active: every 60s");

  // Start recurring template checker
  setInterval(checkRecurringTemplates, RECURRING_CHECK_INTERVAL);

  // Start data retention purge (run once at startup, then hourly)
  purgeOldData();
  setInterval(purgeOldData, PURGE_CHECK_INTERVAL);

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
  setInterval(checkWeeklyReport, WEEKLY_REPORT_INTERVAL);

  console.log("Raffle Bot is running! Press Ctrl+C to stop.");
  await bot.start({
    allowed_updates: [
      "message",
      "callback_query",
      "inline_query",
      "my_chat_member",
      "chat_member",
    ],
  });
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
