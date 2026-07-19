import * as fs from "fs";
import * as path from "path";
import { InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import { parsePrizes } from "./types";
import { metrics, computeLatencyStats } from "./metrics";
import { getJobStats } from "./jobs";
import {
  escapeHtml,
  getUserDisplayName,
  formatRaffleMessage,
  formatWinnersMessage,
  formatCountdown,
  isGroupAdmin,
  parseEndTime,
  replyPrivately,
  buildRaffleKeyboard,
  buildMessageLink,
} from "./helpers";
import { startWizard, handleStartDeepLink, startEditWizard } from "./wizard";
import { t, getLanguageName, getAvailableLanguages } from "./i18n";
import { sendCustomImage, sendWheelSpin, sendRafflePost, getBannerFileId, sendWinnerPost } from "./banners";

// --- Smart debounced post updates ---
// Pattern: first entry refreshes the message immediately (so users see their
// click registered), but subsequent entries within DEBOUNCE_MS are batched
// into a single edit. After the window closes, the next entry starts a
// fresh "immediate" cycle.
//
// This gives both perceived snappiness (instant feedback) AND protection
// from API rate limits during entry bursts.
const DEBOUNCE_MS = 2_500;
interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  ctx: Context;
  lastEditAt: number;
}
const pendingPostUpdates = new Map<number, PendingUpdate>();

function debouncedUpdateRafflePost(ctx: Context, raffleId: number): void {
  const now = Date.now();
  const existing = pendingPostUpdates.get(raffleId);

  // First entry in a fresh window — edit immediately
  if (!existing || now - existing.lastEditAt > DEBOUNCE_MS) {
    if (existing) clearTimeout(existing.timer);
    pendingPostUpdates.set(raffleId, {
      timer: setTimeout(() => {}, 0), // placeholder, replaced below
      ctx,
      lastEditAt: now,
    });
    updateRafflePost(ctx, raffleId).catch((err) =>
      console.error("Failed to update raffle post:", err)
    );
    // Schedule a "trailing edge" refresh in case more entries arrive during the window
    const trailingTimer = setTimeout(() => {
      const e = pendingPostUpdates.get(raffleId);
      if (e) {
        pendingPostUpdates.delete(raffleId);
        updateRafflePost(ctx, raffleId).catch((err) =>
          console.error("Failed to update raffle post (trailing):", err)
        );
      }
    }, DEBOUNCE_MS);
    pendingPostUpdates.get(raffleId)!.timer = trailingTimer;
    return;
  }

  // Subsequent entry within the debounce window — refresh the trailing timer
  clearTimeout(existing.timer);
  existing.ctx = ctx;
  existing.timer = setTimeout(() => {
    pendingPostUpdates.delete(raffleId);
    updateRafflePost(ctx, raffleId).catch((err) =>
      console.error("Failed to update raffle post (trailing):", err)
    );
  }, DEBOUNCE_MS);
}

/**
 * Estimate a Telegram account's age in days based on user ID ranges.
 * Telegram IDs are roughly sequential; this uses known reference points.
 * Returns null if unable to estimate (very old accounts).
 */
function estimateAccountAgeDays(userId: number): number | null {
  // Known approximate reference points (userId → Unix timestamp)
  const refs: Array<[number, number]> = [
    [1_000_000_000, new Date("2020-06-01").getTime()],
    [2_000_000_000, new Date("2021-05-01").getTime()],
    [5_000_000_000, new Date("2022-06-01").getTime()],
    [6_000_000_000, new Date("2023-01-01").getTime()],
    [7_000_000_000, new Date("2024-01-01").getTime()],
    [8_000_000_000, new Date("2025-01-01").getTime()],
  ];

  // Very old accounts (pre-2020) — can't estimate well, assume old enough
  if (userId < refs[0][0]) return null;

  // Find surrounding reference points and interpolate
  for (let i = 0; i < refs.length - 1; i++) {
    if (userId >= refs[i][0] && userId < refs[i + 1][0]) {
      const fraction =
        (userId - refs[i][0]) / (refs[i + 1][0] - refs[i][0]);
      const estimatedMs =
        refs[i][1] + fraction * (refs[i + 1][1] - refs[i][1]);
      return Math.floor((Date.now() - estimatedMs) / 86_400_000);
    }
  }

  // Beyond last reference — extrapolate from last two points
  const last = refs[refs.length - 1];
  const prev = refs[refs.length - 2];
  const rate = (last[1] - prev[1]) / (last[0] - prev[0]);
  const estimatedMs = last[1] + (userId - last[0]) * rate;
  return Math.max(0, Math.floor((Date.now() - estimatedMs) / 86_400_000));
}

/** Format a duration in ms to a human-readable string like "2h 30m" */
function formatDurationHuman(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "< 1m";
}

// /start - Welcome message (works in private chat)
export async function handleStart(ctx: Context): Promise<void> {
  // Check for deep link payload (e.g., /start newraffle_-1001234567890)
  const text = ctx.message?.text || "";
  const payload = text.replace(/^\/start(@\w+)?/i, "").trim();
  if (payload) {
    const handled = await handleStartDeepLink(ctx, payload);
    if (handled) return;
  }

  await ctx.reply(
    `🎟 <b>Raffle Bot</b>\n\n` +
      `I help you run raffles in Telegram group chats!\n\n` +
      `<b>Commands:</b>\n` +
      `/newraffle - Create a new raffle\n` +
      `/raffles - List open raffles\n` +
      `/draw - Draw winners\n` +
      `/templates - Manage raffle templates\n` +
      `/editraffle - Edit an active raffle\n` +
      `/myentries - See your active entries\n` +
      `/help - Show detailed help\n\n` +
      `Add me to a group to get started!`,
    { parse_mode: "HTML" }
  );
}

// /help
export async function handleHelp(ctx: Context): Promise<void> {
  await replyPrivately(ctx,
    `🎟 <b>Raffle Bot Help</b>\n\n` +
      `<b>Creating a Raffle:</b>\n` +
      `/newraffle - Interactive wizard (in DMs)\n\n` +
      `<b>Quick format:</b>\n` +
      `<code>/newraffle Title | Prize</code>\n\n` +
      `<b>With options:</b>\n` +
      `<code>/newraffle Title | Prize | winners:N | max:N | ends:30m</code>\n\n` +
      `<b>Multiple prizes (one per winner position):</b>\n` +
      `<code>/newraffle Title | prizes: $100, $50, $25 | ends:1d</code>\n\n` +
      `<b>Parameters:</b>\n` +
      `• <b>Title</b> - Name of the raffle (required)\n` +
      `• <b>Prize</b> - Single prize (or use prizes: for multiple)\n` +
      `• <b>prizes: A, B, C</b> - Comma-separated prizes for 1st, 2nd, 3rd...\n` +
      `• <b>winners:N</b> - Number of winners (default: 1, auto-set from prizes count)\n` +
      `• <b>max:N</b> - Maximum entries (auto-draws when full)\n` +
      `• <b>ends:TIME</b> - Auto-close time (30m, 2h, 1d)\n` +
      `• <b>sponsor:Name</b> - Add a sponsor to the raffle\n\n` +
      `<b>Wizard options:</b> The interactive wizard also supports:\n` +
      `• 👁 Anonymous mode (hide entries until draw)\n` +
      `• 🖼 Raffle banner image\n` +
      `• 🕐 Delayed start time\n` +
      `• 💎 Sponsor\n` +
      `• 📌 Auto-pin raffle message\n\n` +
      `<b>Templates:</b>\n` +
      `/templates - Create, use, delete & manage templates\n\n` +
      `<b>Management:</b>\n` +
      `/draw [id] - Draw winners (admin only)\n` +
      `/editraffle [id] - Edit an active raffle (admin only)\n` +
      `/cancelraffle [id] - Cancel a raffle (admin only)\n` +
      `/exportentries [id] - Export all participants (admin only — works in group or DM)\n` +
      `/rerun [id] - Re-run a past raffle (admin only)\n` +
      `/language [code] - Set bot language (admin only)\n` +
      `/raffles - List open raffles in this chat\n` +
      `/rafflehistory - View recent raffle history\n` +
      `/myentries - See your active entries\n\n` +
      `<b>Note:</b> Only group admins can create raffles and draw winners.\n` +
      `<b>Supported languages:</b> English, Espanol, Portugues, Русский, Francais, Deutsch`,
    { parse_mode: "HTML" });
}

// /newraffle - Create a raffle
export async function handleNewRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Raffles can only be created in group chats.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can create raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/newraffle(@\w+)?/i, "").trim();

  if (!args) {
    // Launch the interactive wizard
    await startWizard(ctx);
    return;
  }

  const parts = args.split("|").map((p) => p.trim());

  const title = parts[0];
  if (!title) {
    await replyPrivately(ctx, "Title is required.");
    return;
  }

  let singlePrize = "";
  let prizesList: string[] | null = null;
  let maxWinners = 1;
  let maxEntries: number | null = null;
  let endsAt: string | null = null;
  let description = "";
  let sponsorName: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const partLower = part.toLowerCase();

    const winnersMatch = partLower.match(/^winners?\s*:\s*(\d+)$/);
    const maxMatch = partLower.match(/^max\s*:\s*(\d+)$/);
    const endsMatch = part.match(/^ends?\s*:\s*(.+)$/i);
    const prizesMatch = part.match(/^prizes?\s*:\s*(.+)$/i);
    const sponsorMatch = part.match(/^sponsor\s*:\s*(.+)$/i);

    if (winnersMatch) {
      maxWinners = Math.max(1, Math.min(50, parseInt(winnersMatch[1], 10)));
    } else if (maxMatch) {
      maxEntries = Math.max(1, parseInt(maxMatch[1], 10));
    } else if (endsMatch) {
      const parsed = parseEndTime(endsMatch[1].trim());
      if (parsed) {
        endsAt = parsed.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      } else {
        await replyPrivately(ctx,
          `Could not parse end time "${endsMatch[1]}". Use formats like: 30m, 2h, 1d`
        );
        return;
      }
    } else if (prizesMatch) {
      prizesList = prizesMatch[1]
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (prizesList.length === 0) {
        await replyPrivately(ctx, "Please provide at least one prize.");
        return;
      }
    } else if (sponsorMatch) {
      sponsorName = sponsorMatch[1].trim();
    } else if (!singlePrize) {
      // First unrecognized segment is the single prize
      singlePrize = part;
    } else {
      // Extra text goes into description
      description += (description ? "\n" : "") + part;
    }
  }

  // If prizes: was used, auto-set max_winners to match prize count (unless explicitly set)
  if (prizesList && prizesList.length > 1) {
    const explicitWinners = parts.some((p) =>
      p.toLowerCase().match(/^winners?\s*:\s*\d+$/)
    );
    if (!explicitWinners) {
      maxWinners = prizesList.length;
    }
  }

  // Need either a single prize or a prizes list
  const finalPrize = singlePrize || (prizesList ? prizesList[0] : "");
  if (!finalPrize) {
    await replyPrivately(ctx,
      "Please provide a prize.\n" +
        "Example: <code>/newraffle Title | Prize</code>\n" +
        "Or: <code>/newraffle Title | prizes: $100, $50, $25</code>",
      { parse_mode: "HTML" });
    return;
  }

  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  const threadId = ctx.message?.message_thread_id ?? null;

  const raffle = db.createRaffle({
    chat_id: ctx.chat.id,
    thread_id: threadId,
    creator_id: userId,
    creator_name: displayName,
    title,
    description,
    prize: finalPrize,
    prizes: prizesList ? JSON.stringify(prizesList) : null,
    max_entries: maxEntries,
    max_winners: maxWinners,
    ends_at: endsAt,
    starts_at: null,
    display_timezone: db.getChatTimezone(ctx.chat.id),
    required_chat_id: null,
    required_chat_title: null,
    sponsor_name: sponsorName,
    anonymous: 0,
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

  const lang = db.getChatLanguage(ctx.chat.id);
  const botUsername = ctx.me.username;

  const keyboard = buildRaffleKeyboard(raffle, 0, lang, botUsername);

  const msgId = await sendRafflePost(
    ctx.api,
    ctx.chat.id,
    "open",
    formatRaffleMessage(raffle, 0, lang),
    keyboard,
    null,
    raffle.thread_id
  );

  if (msgId) {
    db.updateRaffleMessageId(raffle.id, msgId);
  }
}

// /raffles - List open raffles
export async function handleListRaffles(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const raffles = db.getOpenRafflesForChat(ctx.chat.id);

  if (raffles.length === 0) {
    await replyPrivately(ctx,
      "No open raffles in this chat. Use /newraffle to create one!");
    return;
  }

  let msg = `🎟 <b>Open Raffles (${raffles.length})</b>\n\n`;
  for (const raffle of raffles) {
    const count = db.getEntryCount(raffle.id);
    const maxStr = raffle.max_entries ? `/${raffle.max_entries}` : "";
    const prizes = parsePrizes(raffle);

    msg += `<b>${raffle.id}.</b> ${escapeHtml(raffle.title)}\n`;
    if (prizes.length > 1) {
      msg += `   🎁 ${prizes.length} prizes | 👥 ${count}${maxStr} entries\n`;
    } else {
      msg += `   🎁 ${escapeHtml(prizes[0])} | 👥 ${count}${maxStr} entries\n`;
    }
    if (raffle.ends_at) {
      msg += `   ⏰ Ends: ${formatCountdown(new Date(raffle.ends_at + "Z"))}\n`;
    }
    msg += `\n`;
  }

  await replyPrivately(ctx, msg, { parse_mode: "HTML" });
}

// /draw - Draw winners
export async function handleDraw(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can draw raffle winners.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/draw(@\w+)?/i, "").trim();

  let raffle: ReturnType<typeof db.getRaffleById>;

  if (args) {
    const raffleId = parseInt(args, 10);
    if (isNaN(raffleId)) {
      await replyPrivately(ctx, "Please provide a valid raffle ID. Usage: /draw 1");
      return;
    }
    raffle = db.getRaffleById(raffleId);
  } else {
    const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);
    if (openRaffles.length === 0) {
      await replyPrivately(ctx, "No open raffles to draw from.");
      return;
    }
    if (openRaffles.length === 1) {
      raffle = openRaffles[0];
    } else {
      let msg = `Multiple open raffles found. Please specify which one:\n\n`;
      for (const r of openRaffles) {
        msg += `/draw ${r.id} - ${escapeHtml(r.title)}\n`;
      }
      await replyPrivately(ctx, msg, { parse_mode: "HTML" });
      return;
    }
  }

  if (!raffle) {
    await replyPrivately(ctx, "Raffle not found.");
    return;
  }

  if (raffle.chat_id !== ctx.chat.id) {
    await replyPrivately(ctx, "That raffle doesn't belong to this chat.");
    return;
  }

  if (raffle.status === "drawn") {
    await replyPrivately(ctx, "This raffle has already been drawn.");
    return;
  }

  const entryCount = db.getEntryCount(raffle.id);
  if (entryCount === 0) {
    db.markRaffleDrawn(raffle.id);
    await revokeReferralInviteLinks(ctx.api, raffle.id);
    await replyPrivately(ctx,
      `🎟 <b>${escapeHtml(raffle.title)}</b>\n\nNo entries were received. Raffle closed with no winners.`,
      { parse_mode: "HTML" });
    await updateRafflePost(ctx, raffle.id);
    return;
  }

  const lang = db.getChatLanguage(ctx.chat!.id);
  const entries = db.getEntriesForRaffle(raffle.id);
  const entryNames = entries.map((e) => e.user_display_name);
  const winners = db.selectWinners(raffle.id);

  // Countdown animation (if animation enabled and at least 1 entry)
  if (entryNames.length >= 1 && raffle.show_animation) {
    await sendWheelSpin(ctx.api, ctx.chat!.id, raffle.thread_id);
  }

  // Announce winners with embedded "WINNERS DRAWN" banner
  await sendWinnerPost(ctx.api, ctx.chat!.id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);

  // Mark as drawn and announced after successful announcement
  db.markRaffleDrawn(raffle.id);
  db.markRaffleAnnounced(raffle.id);
  await revokeReferralInviteLinks(ctx.api, raffle.id);

  await updateRafflePost(ctx, raffle.id);

  // DM winners and the creator
  await notifyWinnersAndCreator(ctx.api, raffle, winners);
}

// /cancelraffle - Cancel a raffle (sends interactive buttons to DM)
export async function handleCancelRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can cancel raffles.");
    return;
  }

  const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);
  if (openRaffles.length === 0) {
    await replyPrivately(ctx, "No open raffles to cancel.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const r of openRaffles) {
    keyboard.text(`🎟 ${r.title}`, `cancel_pick_${r.id}`).row();
  }
  keyboard.text("❌ Nevermind", `cancel_no`);

  await replyPrivately(ctx,
    `Which raffle do you want to cancel?`,
    { reply_markup: keyboard });
}

// Callback handler for cancel buttons (runs in DM)
export async function handleCancelCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  await ctx.answerCallbackQuery();

  // "Nevermind" button
  if (data === "cancel_no") {
    await ctx.editMessageText("👍 No raffle was cancelled.");
    return;
  }

  // Pick a raffle → show confirmation
  const pickMatch = data.match(/^cancel_pick_(\d+)$/);
  if (pickMatch) {
    const raffleId = parseInt(pickMatch[1], 10);
    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.status !== "open") {
      await ctx.editMessageText("This raffle is no longer open.");
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("✅ Yes, cancel it", `cancel_yes_${raffleId}`)
      .text("❌ No, keep it", `cancel_no`);
    await ctx.editMessageText(
      `⚠️ Cancel raffle <b>${escapeHtml(raffle.title)}</b>?\n\nThis cannot be undone.`,
      { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  // Confirm cancellation
  const yesMatch = data.match(/^cancel_yes_(\d+)$/);
  if (yesMatch) {
    const raffleId = parseInt(yesMatch[1], 10);
    const raffle = db.getRaffleById(raffleId);
    if (!raffle) {
      await ctx.editMessageText("Raffle not found.");
      return;
    }
    if (raffle.status === "drawn") {
      await ctx.editMessageText("Cannot cancel a raffle that has already been drawn.");
      return;
    }
    if (raffle.status !== "open") {
      await ctx.editMessageText("This raffle is no longer open.");
      return;
    }

    db.closeRaffle(raffleId);
    await revokeReferralInviteLinks(ctx.api, raffleId);

    await ctx.editMessageText(
      `🚫 Raffle <b>${escapeHtml(raffle.title)}</b> has been cancelled.`,
      { parse_mode: "HTML" });

    // Update the raffle post in the group
    await updateRafflePost(ctx, raffleId);
  }
}

// Callback handler for repost button (admin-only, on raffle post)
export async function handleRepostCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^repost_(\d+)$/);
  if (!match) return;

  const raffleId = parseInt(match[1], 10);
  const userId = ctx.from!.id;

  // Admin check
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== "open") {
    await ctx.answerCallbackQuery({ text: "This raffle is no longer open.", show_alert: true });
    return;
  }

  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await ctx.answerCallbackQuery({ text: "Only group admins can repost raffles.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Reposting raffle..." });

  const chatId = raffle.chat_id;
  const oldMessageId = raffle.message_id;
  const lang = db.getChatLanguage(chatId);
  const botUsername = ctx.me.username;

  const count = db.getEntryCount(raffleId);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;
  const caption = formatRaffleMessage(raffle, count, lang);
  const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);

  // Send a new raffle post at the bottom of the chat
  const newMsgId = await sendRafflePost(
    ctx.api,
    chatId,
    "open",
    caption,
    keyboard,
    raffle.image_file_id,
    raffle.thread_id
  );

  if (!newMsgId) {
    await ctx.api.sendMessage(userId, "Failed to repost the raffle. Please try again.");
    return;
  }

  // Update the database to point to the new message
  db.updateRaffleMessageId(raffleId, newMsgId);

  // Handle the old post: try to delete, otherwise edit with a link
  if (oldMessageId) {
    try {
      await ctx.api.deleteMessage(chatId, oldMessageId);
    } catch {
      // Deletion failed (probably older than 48h) — edit with a redirect link
      const newLink = buildMessageLink(chatId, newMsgId);
      const redirectText = newLink
        ? `⬇️ <b>This raffle has moved.</b>\n\n<a href="${newLink}">Tap here to go to the active raffle</a>`
        : `⬇️ <b>This raffle has moved.</b> Scroll down to find it.`;
      try {
        await ctx.api.editMessageCaption(chatId, oldMessageId, {
          caption: redirectText,
          parse_mode: "HTML",
        });
      } catch {
        try {
          await ctx.api.editMessageText(chatId, oldMessageId, redirectText, {
            parse_mode: "HTML",
          });
        } catch {
          // Old message couldn't be edited either — ignore
        }
      }
    }
  }

  // Auto-pin the new post if the raffle had auto_pin enabled
  if (raffle.auto_pin) {
    try {
      await ctx.api.pinChatMessage(chatId, newMsgId, { disable_notification: true });
    } catch {
      // Pin failed — bot may not have pin permissions
    }
  }
}

// /myentries - Show user's active entries
export async function handleMyEntries(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);

  const entered = openRaffles.filter((r) => db.hasUserEntered(r.id, userId));

  if (entered.length === 0) {
    await replyPrivately(ctx, "You haven't entered any active raffles in this chat.");
    return;
  }

  let msg = `🎟 <b>Your Active Entries</b>\n\n`;
  for (const r of entered) {
    const prizes = parsePrizes(r);
    msg += `• ${escapeHtml(r.title)} (ID: ${r.id})\n`;
    if (prizes.length > 1) {
      msg += `  🎁 ${prizes.length} prizes available\n`;
    } else {
      msg += `  🎁 ${escapeHtml(prizes[0])}\n`;
    }
    if (r.referral_enabled) {
      const bonus = db.getBonusEntries(r.id, userId);
      msg += `  🔗 ${1 + bonus} total entries (${bonus} referral bonus)\n`;
    }
  }

  await replyPrivately(ctx, msg, { parse_mode: "HTML" });
}

// /rafflehistory - Show recent raffles
export async function handleRaffleHistory(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const raffles = db.getRecentRafflesForChat(ctx.chat.id, 10);

  if (raffles.length === 0) {
    await replyPrivately(ctx, "No raffle history in this chat.");
    return;
  }

  let msg = `📜 <b>Recent Raffles</b>\n\n`;
  for (const raffle of raffles) {
    const statusEmoji =
      raffle.status === "open"
        ? "🟢"
        : raffle.status === "closed"
          ? "🔴"
          : "🏆";
    const count = db.getEntryCount(raffle.id);
    const prizes = parsePrizes(raffle);

    msg += `${statusEmoji} <b>${escapeHtml(raffle.title)}</b> (ID: ${raffle.id})\n`;
    if (prizes.length > 1) {
      msg += `   🎁 ${prizes.length} prizes | 👥 ${count} entries | ${raffle.status}\n`;
    } else {
      msg += `   🎁 ${escapeHtml(prizes[0])} | 👥 ${count} entries | ${raffle.status}\n`;
    }

    if (raffle.status === "drawn") {
      const winners = db.getWinnersForRaffle(raffle.id);
      if (winners.length > 0) {
        winners.forEach((w) => {
          if (w.prize) {
            msg += `   🏆 ${escapeHtml(w.user_display_name)} — ${escapeHtml(w.prize)}\n`;
          } else {
            msg += `   🏆 ${escapeHtml(w.user_display_name)}\n`;
          }
        });
      }
    }
    msg += `\n`;
  }

  await replyPrivately(ctx, msg, { parse_mode: "HTML" });
}

// /exportentries - Export all participants for a raffle.
// Works in two contexts:
//   - In a group: lists/exports raffles from that group (admin only)
//   - In DM:      lists/exports raffles the user CREATED across all groups
//                 (admin-of-chat fallback for non-creator admins)
export async function handleExportEntries(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const userId = ctx.from.id;
  const text = ctx.message?.text || "";
  const args = text.replace(/^\/exportentries(@\w+)?/i, "").trim();
  const inDm = ctx.chat.type === "private";

  // ---- Listing branch (no raffle ID provided) ----
  if (!args) {
    if (inDm) {
      // DM: list raffles this user created across all groups
      const myRaffles = db.getRecentRafflesByCreator(userId, 30);
      if (myRaffles.length === 0) {
        await ctx.reply(
          "You haven't created any raffles yet.\n\n" +
            "If you want to export a raffle from a group where you're an admin but didn't create it, " +
            "run <code>/exportentries</code> directly in that group instead.",
          { parse_mode: "HTML" }
        );
        return;
      }

      // Group by chat for readability, and look up chat titles
      const byChat = new Map<number, typeof myRaffles>();
      for (const r of myRaffles) {
        if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
        byChat.get(r.chat_id)!.push(r);
      }

      const groupNames = new Map<number, string>();
      for (const chatId of byChat.keys()) {
        const cached = db.getBotGroup(chatId);
        if (cached?.title) {
          groupNames.set(chatId, cached.title);
          continue;
        }
        try {
          const chat = await ctx.api.getChat(chatId);
          if ("title" in chat && chat.title) groupNames.set(chatId, chat.title);
        } catch {
          // Bot may no longer be in the chat — fall through to chat-id fallback
        }
      }

      let msg = `📋 <b>Your recent raffles</b> (across all groups)\n\n`;
      msg += `Reply with the command for the one you want to export:\n\n`;
      for (const [chatId, list] of byChat) {
        const name = groupNames.get(chatId) || `Chat ${chatId}`;
        msg += `<b>📍 ${escapeHtml(name)}</b>\n`;
        for (const r of list) {
          const count = db.getEntryCount(r.id);
          msg += `<code>/exportentries ${r.id}</code> — ${escapeHtml(r.title)} (${count} entries, ${r.status})\n`;
        }
        msg += `\n`;
      }
      msg += `<i>Showing up to 30 most recent raffles you created.</i>`;
      // Send in DM (single chunk in most cases; if huge, this will fall through to a single reply
      // and Telegram will truncate visibly — acceptable for the lister UX)
      await ctx.reply(msg, { parse_mode: "HTML" });
      return;
    }

    // Group: existing behavior — list raffles in this chat (admin only)
    const isAdmin = await isGroupAdmin(ctx, userId);
    if (!isAdmin) {
      await replyPrivately(ctx, "Only group admins can export entries.");
      return;
    }
    const allRaffles = db.getRecentRafflesForChat(ctx.chat.id, 20);
    if (allRaffles.length === 0) {
      await replyPrivately(ctx, "No raffles found in this chat.");
      return;
    }
    let msg = `Which raffle do you want to export?\n\n`;
    for (const r of allRaffles) {
      const count = db.getEntryCount(r.id);
      msg += `/exportentries ${r.id} - ${escapeHtml(r.title)} (${count} entries, ${r.status})\n`;
    }
    await replyPrivately(ctx, msg, { parse_mode: "HTML" });
    return;
  }

  // ---- Export branch (raffle ID provided) ----
  const raffleId = parseInt(args, 10);
  if (isNaN(raffleId)) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("Please provide a valid raffle ID.");
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("Raffle not found.");
    return;
  }

  // Authorization: must be the creator OR an admin of the raffle's chat
  let authorized = raffle.creator_id === userId;
  if (!authorized) {
    if (!inDm && raffle.chat_id !== ctx.chat.id) {
      // In a group context, raffle has to belong to this chat
      await replyPrivately(ctx, "Raffle not found in this chat.");
      return;
    }
    // Verify they're an admin of the raffle's chat
    try {
      const member = await ctx.api.getChatMember(raffle.chat_id, userId);
      authorized = member.status === "administrator" || member.status === "creator";
    } catch {
      authorized = false;
    }
  }
  if (!authorized) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("You can only export raffles you created or that you're an admin of.");
    return;
  }

  const entries = db.getEntriesForRaffle(raffleId);
  if (entries.length === 0) {
    const reply = (text: string, opts?: { parse_mode?: string }) =>
      inDm ? ctx.reply(text, opts as Record<string, unknown>) : replyPrivately(ctx, text, opts);
    await reply(`No entries found for raffle "${escapeHtml(raffle.title)}".`, { parse_mode: "HTML" });
    return;
  }

  // Build the message
  let msg = `📋 <b>Participants Export: ${escapeHtml(raffle.title)}</b>\n`;
  msg += `<b>Raffle ID:</b> ${raffle.id} | <b>Status:</b> ${raffle.status}\n`;
  msg += `<b>Total Entries:</b> ${entries.length}\n\n`;
  msg += `<b>Participant List:</b>\n`;
  entries.forEach((e, i) => {
    const username = e.user_name ? `@${e.user_name}` : `[${e.user_id}]`;
    msg += `${i + 1}. ${escapeHtml(e.user_display_name)} (${username})\n`;
  });
  msg += `\n<b>User IDs (for re-run):</b>\n<code>`;
  msg += entries.map((e) => e.user_id).join(", ");
  msg += `</code>`;
  msg += `\n\n💡 Use <code>/rerun ${raffle.id}</code> to create a new raffle with these same participants.`;

  // If too long, fall back to a CSV document attachment
  if (msg.length > 4000) {
    const csvLines = ["#,Display Name,Username,User ID,Entered At"];
    entries.forEach((e, i) => {
      csvLines.push(
        `${i + 1},"${e.user_display_name}","${e.user_name || ""}",${e.user_id},"${e.entered_at}"`
      );
    });
    const buffer = Buffer.from(csvLines.join("\n"), "utf-8");
    try {
      await ctx.api.sendDocument(userId,
        new InputFile(buffer, `raffle_${raffle.id}_participants.csv`),
        {
          caption: `📋 Participants for "${raffle.title}" (${entries.length} entries)\n\nUse /rerun ${raffle.id} to create a new raffle with these same participants.`,
        }
      );
    } catch {
      const fallback = `Export has ${entries.length} entries — please DM me first so I can send you the file.`;
      if (inDm) await ctx.reply(fallback);
      else await replyPrivately(ctx, fallback);
    }
    return;
  }

  // Short enough — send as a text message
  if (inDm) {
    await ctx.reply(msg, { parse_mode: "HTML" });
  } else {
    await replyPrivately(ctx, msg, { parse_mode: "HTML" });
  }
}

// /rerun - Re-run a raffle with same participants from a previous one
export async function handleRerun(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can re-run raffles.");
    return;
  }

  const drawnRaffles = db
    .getRecentRafflesForChat(ctx.chat.id, 20)
    .filter((r) => r.status === "drawn" || r.status === "closed");

  if (drawnRaffles.length === 0) {
    await ctx.reply("No completed raffles to re-run.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const r of drawnRaffles.slice(0, 10)) {
    const count = db.getEntryCount(r.id);
    keyboard.text(
      `${escapeHtml(r.title)} (${count} entries)`,
      `rerun_pick_${r.id}`
    );
    keyboard.row();
  }
  keyboard.text("❌ Cancel", "rerun_cancel");

  await ctx.reply(
    `🔄 <b>Re-run a Raffle</b>\n\n` +
      `Pick a completed raffle to re-run with the same participants:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleRerunCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // Cancel button
  if (data === "rerun_cancel") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Re-run cancelled.");
    return;
  }

  // Pick a raffle to preview
  if (data.startsWith("rerun_pick_")) {
    const sourceId = parseInt(data.replace("rerun_pick_", ""), 10);
    if (isNaN(sourceId)) return;

    const sourceRaffle = db.getRaffleById(sourceId);
    if (!sourceRaffle) {
      await ctx.answerCallbackQuery({ text: "Raffle not found.", show_alert: true });
      return;
    }

    const entryCount = db.getEntryCount(sourceId);
    const prizes = sourceRaffle.prizes
      ? (JSON.parse(sourceRaffle.prizes) as string[]).map((p) => escapeHtml(p)).join(", ")
      : escapeHtml(sourceRaffle.prize);

    // Calculate original duration for display
    let timerLine = `⏰ <b>Timer:</b> No time limit\n`;
    if (sourceRaffle.ends_at && sourceRaffle.created_at) {
      const durationMs =
        new Date(sourceRaffle.ends_at + "Z").getTime() -
        new Date(sourceRaffle.created_at + "Z").getTime();
      if (durationMs > 0) {
        timerLine = `⏰ <b>Timer:</b> ${formatDurationHuman(durationMs)}\n`;
      }
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("✅ Re-run This Raffle", `rerun_confirm_${sourceId}`)
      .row()
      .text("⬅️ Back", "rerun_back");

    await ctx.editMessageText(
      `🔄 <b>Re-run: ${escapeHtml(sourceRaffle.title)}</b>\n\n` +
        `🎁 <b>Prize:</b> ${prizes}\n` +
        `🏆 <b>Winners:</b> ${sourceRaffle.max_winners}\n` +
        `👥 <b>Entries to copy:</b> ${entryCount}\n` +
        timerLine +
        (sourceRaffle.sponsor_name ? `💎 <b>Sponsor:</b> ${escapeHtml(sourceRaffle.sponsor_name)}\n` : "") +
        `\n<i>A new open raffle will be created with all ${entryCount} participants pre-entered.</i>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // Back to raffle list
  if (data === "rerun_back") {
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (!chatId) return;

    const drawnRaffles = db
      .getRecentRafflesForChat(chatId, 20)
      .filter((r) => r.status === "drawn" || r.status === "closed");

    const keyboard = new InlineKeyboard();
    for (const r of drawnRaffles.slice(0, 10)) {
      const count = db.getEntryCount(r.id);
      keyboard.text(
        `${escapeHtml(r.title)} (${count} entries)`,
        `rerun_pick_${r.id}`
      );
      keyboard.row();
    }
    keyboard.text("❌ Cancel", "rerun_cancel");

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔄 <b>Re-run a Raffle</b>\n\n` +
        `Pick a completed raffle to re-run with the same participants:`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // Confirm re-run
  if (data.startsWith("rerun_confirm_")) {
    const sourceId = parseInt(data.replace("rerun_confirm_", ""), 10);
    if (isNaN(sourceId)) return;

    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (!chatId) return;

    const sourceRaffle = db.getRaffleById(sourceId);
    if (!sourceRaffle || sourceRaffle.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: "Raffle not found.", show_alert: true });
      return;
    }

    const sourceEntries = db.getEntriesForRaffle(sourceId);
    if (sourceEntries.length === 0) {
      await ctx.answerCallbackQuery({ text: "No entries to copy.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Remove the selection message
    try {
      await ctx.deleteMessage();
    } catch {}

    const displayName = getUserDisplayName(
      ctx.from.first_name,
      ctx.from.last_name
    );

    // Calculate ends_at using the same duration as the original raffle
    let newEndsAt: string | null = null;
    if (sourceRaffle.ends_at && sourceRaffle.created_at) {
      const durationMs =
        new Date(sourceRaffle.ends_at + "Z").getTime() -
        new Date(sourceRaffle.created_at + "Z").getTime();
      if (durationMs > 0) {
        const newEnd = new Date(Date.now() + durationMs);
        newEndsAt = newEnd
          .toISOString()
          .replace("T", " ")
          .replace("Z", "")
          .split(".")[0];
      }
    }

    // Create a new raffle with the same settings
    const newRaffle = db.createRaffle({
      chat_id: chatId,
      thread_id: sourceRaffle.thread_id,
      creator_id: ctx.from.id,
      creator_name: displayName,
      title: `${sourceRaffle.title} (Re-run)`,
      description: sourceRaffle.description,
      prize: sourceRaffle.prize,
      prizes: sourceRaffle.prizes,
      max_entries: null,
      max_winners: sourceRaffle.max_winners,
      ends_at: newEndsAt,
      starts_at: null,
      display_timezone: db.getChatTimezone(chatId),
      required_chat_id: sourceRaffle.required_chat_id,
      required_chat_title: sourceRaffle.required_chat_title,
      sponsor_name: sourceRaffle.sponsor_name,
      anonymous: sourceRaffle.anonymous,
      image_file_id: sourceRaffle.image_file_id,
      auto_pin: sourceRaffle.auto_pin,
      min_account_age_days: sourceRaffle.min_account_age_days,
      require_username: sourceRaffle.require_username,
      winner_cooldown: sourceRaffle.winner_cooldown,
      show_animation: sourceRaffle.show_animation,
      referral_enabled: sourceRaffle.referral_enabled,
      max_referral_entries: sourceRaffle.max_referral_entries,
      revoke_referral_links: sourceRaffle.revoke_referral_links,
    });

    // Copy all entries from the source raffle
    const added = db.bulkAddEntries(
      newRaffle.id,
      sourceEntries.map((e) => ({
        user_id: e.user_id,
        user_name: e.user_name,
        user_display_name: e.user_display_name,
      }))
    );

    const rerunLang = db.getChatLanguage(chatId);
    const botUsername = ctx.me.username;

    const raffleKeyboard = buildRaffleKeyboard(newRaffle, added, rerunLang, botUsername);

    const caption = formatRaffleMessage(newRaffle, added, rerunLang) +
      `\n\n🔄 <i>Re-run of "${escapeHtml(sourceRaffle.title)}" with ${added} participants copied.</i>`;

    const msgId = await sendRafflePost(
      ctx.api,
      chatId,
      "open",
      caption,
      raffleKeyboard,
      newRaffle.image_file_id,
      newRaffle.thread_id
    );

    if (msgId) {
      db.updateRaffleMessageId(newRaffle.id, msgId);
    }

  }
}

// ===================================================================
// TEMPLATE HUB — Button-based template management
// ===================================================================

/** Format template details for preview */
function formatTemplateSummary(tmpl: ReturnType<typeof db.getTemplateById>): string {
  if (!tmpl) return "Template not found.";
  let msg = "";
  msg += `📝 <b>Title:</b> ${escapeHtml(tmpl.title)}\n`;
  if (tmpl.prizes) {
    try {
      const prizes = JSON.parse(tmpl.prizes) as string[];
      if (prizes.length > 1) {
        msg += `🎁 <b>Prizes:</b> ${prizes.map((p) => escapeHtml(p)).join(", ")}\n`;
      } else {
        msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
      }
    } catch {
      msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
    }
  } else {
    msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
  }
  msg += `🏆 <b>Winners:</b> ${tmpl.max_winners}\n`;
  if (tmpl.max_entries) {
    msg += `👥 <b>Max entries:</b> ${tmpl.max_entries}\n`;
  }
  if (tmpl.duration_minutes) {
    msg += `⏰ <b>Duration:</b> ${formatDurationHuman(tmpl.duration_minutes * 60000)}\n`;
  }
  if (tmpl.sponsor_name) {
    msg += `💎 <b>Sponsor:</b> ${escapeHtml(tmpl.sponsor_name)}\n`;
  }
  if (tmpl.anonymous) {
    msg += `👁 <b>Hidden entries:</b> On\n`;
  }
  if (tmpl.recurring_interval_minutes) {
    const interval = formatDurationHuman(tmpl.recurring_interval_minutes * 60000);
    msg += `🔄 <b>Recurring:</b> every ${interval}`;
    msg += tmpl.recurring_active ? " (active)\n" : " (paused)\n";
  }
  return msg;
}

/** Build and show the template list hub (send new or edit existing message) */
async function buildTemplateHub(
  ctx: Context,
  chatId: number,
  edit: boolean = false
): Promise<void> {
  const templates = db.getTemplatesForChat(chatId);

  // Get bot username for deep-link URL
  const botInfo = await ctx.api.getMe();
  const botUsername = botInfo.username || "bot";

  const keyboard = new InlineKeyboard();
  for (const tmpl of templates.slice(0, 10)) {
    let label = tmpl.name;
    if (tmpl.recurring_active) label += " 🔄";
    keyboard.text(label, `tmpl_pick_${tmpl.id}`);
    keyboard.row();
  }
  // Deep-link URL button — opens DM and starts template wizard immediately
  keyboard.url("➕ Create New", `https://t.me/${botUsername}?start=tmpl_${chatId}`);
  keyboard.row();
  keyboard.text("❌ Close", "tmpl_cancel");

  const text =
    templates.length > 0
      ? `📋 <b>Templates (${templates.length})</b>\n\nTap a template to use, edit, or delete:`
      : `📋 <b>Templates</b>\n\nNo templates saved yet. Tap below to create one:`;

  if (edit) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}

/** Handle all tmpl_* callback queries */
export async function handleTemplateCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const chatId = ctx.callbackQuery?.message?.chat?.id;
  if (!chatId) return;

  // --- Close hub ---
  if (data === "tmpl_cancel") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  // --- Back to template list ---
  if (data === "tmpl_back") {
    await ctx.answerCallbackQuery();
    await buildTemplateHub(ctx, chatId, true);
    return;
  }

  // tmpl_create is no longer a callback — it's now a URL deep-link button

  // --- Pick a template (action menu) ---
  if (data.startsWith("tmpl_pick_")) {
    const templateId = parseInt(data.replace("tmpl_pick_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("🚀 Use Template", `tmpl_use_${tmpl.id}`)
      .row();

    if (tmpl.recurring_interval_minutes) {
      keyboard.text(
        tmpl.recurring_active ? "⏸ Pause Recurring" : "🔄 Start Recurring",
        `tmpl_recur_${tmpl.id}`
      );
      keyboard.row();
    }

    keyboard
      .text("🗑 Delete", `tmpl_delete_${tmpl.id}`)
      .text("⬅️ Back", "tmpl_back");

    await ctx.editMessageText(
      `📋 <b>Template: "${escapeHtml(tmpl.name)}"</b>\n\n` +
        formatTemplateSummary(tmpl),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Use template (confirmation screen) ---
  if (data.startsWith("tmpl_use_confirm_")) {
    const templateId = parseInt(data.replace("tmpl_use_confirm_", ""), 10);
    if (isNaN(templateId)) return;

    const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
    if (!isAdmin) {
      await ctx.answerCallbackQuery({ text: "Only admins can create raffles.", show_alert: true });
      return;
    }

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl || tmpl.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Delete the hub message
    try {
      await ctx.deleteMessage();
    } catch {}

    // Create the raffle (reuses logic from handleUseTemplate)
    const displayName = getUserDisplayName(ctx.from.first_name, ctx.from.last_name);

    let endsAt: string | null = null;
    if (tmpl.duration_minutes) {
      const endDate = new Date(Date.now() + tmpl.duration_minutes * 60 * 1000);
      endsAt = endDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    }

    const raffle = db.createRaffle({
      chat_id: chatId,
      thread_id: tmpl.thread_id,
      creator_id: ctx.from.id,
      creator_name: displayName,
      title: tmpl.title,
      description: "",
      prize: tmpl.prize,
      prizes: tmpl.prizes,
      max_entries: tmpl.max_entries,
      max_winners: tmpl.max_winners,
      ends_at: endsAt,
      starts_at: null,
      display_timezone: db.getChatTimezone(chatId),
      required_chat_id: null,
      required_chat_title: null,
      sponsor_name: tmpl.sponsor_name,
      anonymous: tmpl.anonymous,
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

    const lang = db.getChatLanguage(chatId);
    const botUsername = ctx.me.username;

    const raffleKeyboard = buildRaffleKeyboard(raffle, 0, lang, botUsername);

    const msgId = await sendRafflePost(
      ctx.api,
      chatId,
      "open",
      formatRaffleMessage(raffle, 0, lang),
      raffleKeyboard,
      null,
      raffle.thread_id
    );

    if (msgId) {
      db.updateRaffleMessageId(raffle.id, msgId);
    }

    return;
  }

  if (data.startsWith("tmpl_use_")) {
    const templateId = parseInt(data.replace("tmpl_use_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("✅ Create Raffle", `tmpl_use_confirm_${tmpl.id}`)
      .row()
      .text("⬅️ Back", `tmpl_pick_${tmpl.id}`);

    await ctx.editMessageText(
      `🚀 <b>Create raffle from "${escapeHtml(tmpl.name)}"?</b>\n\n` +
        formatTemplateSummary(tmpl),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Toggle recurring ---
  if (data.startsWith("tmpl_recur_")) {
    const templateId = parseInt(data.replace("tmpl_recur_", ""), 10);
    if (isNaN(templateId)) return;

    const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
    if (!isAdmin) {
      await ctx.answerCallbackQuery({ text: "Only admins can manage recurring.", show_alert: true });
      return;
    }

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl || !tmpl.recurring_interval_minutes) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }

    if (tmpl.recurring_active) {
      db.setRecurringActive(tmpl.id, false, null);
      await ctx.answerCallbackQuery({ text: "Recurring paused." });
    } else {
      const nextRun = new Date(Date.now() + tmpl.recurring_interval_minutes * 60 * 1000);
      const nextRunStr = nextRun.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      db.setRecurringActive(tmpl.id, true, nextRunStr);
      await ctx.answerCallbackQuery({ text: "Recurring activated!" });
    }

    // Refresh the action menu with updated status
    const updated = db.getTemplateById(templateId);
    if (!updated) return;

    const keyboard = new InlineKeyboard()
      .text("🚀 Use Template", `tmpl_use_${updated.id}`)
      .row();

    if (updated.recurring_interval_minutes) {
      keyboard.text(
        updated.recurring_active ? "⏸ Pause Recurring" : "🔄 Start Recurring",
        `tmpl_recur_${updated.id}`
      );
      keyboard.row();
    }

    keyboard
      .text("🗑 Delete", `tmpl_delete_${updated.id}`)
      .text("⬅️ Back", "tmpl_back");

    await ctx.editMessageText(
      `📋 <b>Template: "${escapeHtml(updated.name)}"</b>\n\n` +
        formatTemplateSummary(updated),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Delete confirmation ---
  if (data.startsWith("tmpl_delete_yes_")) {
    const templateId = parseInt(data.replace("tmpl_delete_yes_", ""), 10);
    if (isNaN(templateId)) return;

    const isAdmin = await isGroupAdmin(ctx, ctx.from.id);
    if (!isAdmin) {
      await ctx.answerCallbackQuery({ text: "Only admins can delete templates.", show_alert: true });
      return;
    }

    const tmpl = db.getTemplateById(templateId);
    const name = tmpl ? tmpl.name : "template";

    const deleted = db.deleteTemplateById(templateId);
    if (deleted) {
      await ctx.answerCallbackQuery({ text: `"${name}" deleted.` });
    } else {
      await ctx.answerCallbackQuery({ text: "Template already deleted.", show_alert: true });
    }

    // Return to hub
    await buildTemplateHub(ctx, chatId, true);
    return;
  }

  if (data.startsWith("tmpl_delete_")) {
    const templateId = parseInt(data.replace("tmpl_delete_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("🗑 Yes, Delete", `tmpl_delete_yes_${tmpl.id}`)
      .text("⬅️ Cancel", `tmpl_pick_${tmpl.id}`);

    await ctx.editMessageText(
      `⚠️ <b>Delete template "${escapeHtml(tmpl.name)}"?</b>\n\n` +
        `This cannot be undone.`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }
}

// /savetemplate - Save a raffle configuration as a reusable template
export async function handleSaveTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can save templates.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/savetemplate(@\w+)?/i, "").trim();

  if (!args) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  const parts = args.split("|").map((p) => p.trim());
  const templateName = parts[0];
  if (!templateName) {
    await replyPrivately(ctx, "Template name is required.");
    return;
  }

  const title = parts[1] || templateName;
  let singlePrize = "";
  let prizesList: string[] | null = null;
  let maxWinners = 1;
  let maxEntries: number | null = null;
  let durationMinutes: number | null = null;
  let sponsorName: string | null = null;
  let anonymous = 0;
  let recurringMinutes: number | null = null;

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    const partLower = part.toLowerCase();

    const winnersMatch = partLower.match(/^winners?\s*:\s*(\d+)$/);
    const maxMatch = partLower.match(/^max\s*:\s*(\d+)$/);
    const endsMatch = part.match(/^ends?\s*:\s*(.+)$/i);
    const prizesMatch = part.match(/^prizes?\s*:\s*(.+)$/i);
    const sponsorMatch = part.match(/^sponsor\s*:\s*(.+)$/i);
    const recurringMatch = part.match(/^recurring\s*:\s*(.+)$/i);
    const anonMatch = partLower.match(/^anonymous\s*:\s*(on|off|true|false|1|0|yes|no)$/);

    if (winnersMatch) {
      maxWinners = Math.max(1, Math.min(50, parseInt(winnersMatch[1], 10)));
    } else if (maxMatch) {
      maxEntries = Math.max(1, parseInt(maxMatch[1], 10));
    } else if (endsMatch) {
      const val = endsMatch[1].trim().toLowerCase();
      const durationMatch = val.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
      if (durationMatch) {
        const amount = parseInt(durationMatch[1], 10);
        const unit = durationMatch[2].toLowerCase();
        if (unit.startsWith("m")) durationMinutes = amount;
        else if (unit.startsWith("h")) durationMinutes = amount * 60;
        else if (unit.startsWith("d")) durationMinutes = amount * 60 * 24;
      }
    } else if (prizesMatch) {
      prizesList = prizesMatch[1]
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    } else if (sponsorMatch) {
      sponsorName = sponsorMatch[1].trim();
    } else if (recurringMatch) {
      const val = recurringMatch[1].trim().toLowerCase();
      const recMatch = val.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
      if (recMatch) {
        const amount = parseInt(recMatch[1], 10);
        const unit = recMatch[2].toLowerCase();
        if (unit.startsWith("m")) recurringMinutes = amount;
        else if (unit.startsWith("h")) recurringMinutes = amount * 60;
        else if (unit.startsWith("d")) recurringMinutes = amount * 60 * 24;
      }
    } else if (anonMatch) {
      const val = anonMatch[1].toLowerCase();
      anonymous = ["on", "true", "1", "yes"].includes(val) ? 1 : 0;
    } else if (!singlePrize) {
      singlePrize = part;
    }
  }

  if (prizesList && prizesList.length > 1) {
    const explicitWinners = parts.some((p) =>
      p.toLowerCase().match(/^winners?\s*:\s*\d+$/)
    );
    if (!explicitWinners) {
      maxWinners = prizesList.length;
    }
  }

  const finalPrize = singlePrize || (prizesList ? prizesList[0] : title);

  try {
    const template = db.createTemplate({
      chat_id: ctx.chat.id,
      thread_id: ctx.message?.message_thread_id ?? null,
      creator_id: userId,
      name: templateName,
      title,
      prize: finalPrize,
      prizes: prizesList ? JSON.stringify(prizesList) : null,
      max_entries: maxEntries,
      max_winners: maxWinners,
      duration_minutes: durationMinutes,
      sponsor_name: sponsorName,
      anonymous,
      recurring_interval_minutes: recurringMinutes,
    });

    let msg = `✅ Template <b>${escapeHtml(templateName)}</b> saved!\n\n`;
    msg += `📋 Title: ${escapeHtml(title)}\n`;
    msg += `🎁 Prize: ${escapeHtml(finalPrize)}\n`;
    msg += `🏆 Winners: ${maxWinners}\n`;
    if (durationMinutes) msg += `⏰ Duration: ${durationMinutes}m\n`;
    if (recurringMinutes) msg += `🔄 Recurring: every ${recurringMinutes}m\n`;

    msg += `\nUse <code>/usetemplate ${escapeHtml(templateName)}</code> to create a raffle from this template.`;

    await replyPrivately(ctx, msg, { parse_mode: "HTML" });
  } catch (err: any) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      await replyPrivately(ctx,
        `A template named "${escapeHtml(templateName)}" already exists in this chat.\nDelete it first with <code>/deletetemplate ${escapeHtml(templateName)}</code>`,
        { parse_mode: "HTML" });
    } else {
      throw err;
    }
  }
}

// /templates - Template management hub with inline buttons
export async function handleTemplates(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await ctx.reply("Only group admins can manage templates.");
    return;
  }

  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /deletetemplate - Delete a saved template
export async function handleDeleteTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can delete templates.");
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.replace(/^\/deletetemplate(@\w+)?/i, "").trim();

  if (!name) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  const deleted = db.deleteTemplate(ctx.chat.id, name);
  if (deleted) {
    await replyPrivately(ctx,
      `✅ Template <b>${escapeHtml(name)}</b> deleted.`,
      { parse_mode: "HTML" });
  } else {
    await replyPrivately(ctx,
      `Template "${escapeHtml(name)}" not found.`,
      { parse_mode: "HTML" });
  }
}

// /usetemplate - Create a raffle from a saved template
export async function handleUseTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can create raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.replace(/^\/usetemplate(@\w+)?/i, "").trim();

  if (!name) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  const template = db.getTemplateByName(ctx.chat.id, name);
  if (!template) {
    await replyPrivately(ctx,
      `Template "${escapeHtml(name)}" not found. Use /templates to see saved templates.`,
      { parse_mode: "HTML" });
    return;
  }

  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  let endsAt: string | null = null;
  if (template.duration_minutes) {
    const endDate = new Date(Date.now() + template.duration_minutes * 60 * 1000);
    endsAt = endDate
      .toISOString()
      .replace("T", " ")
      .replace("Z", "")
      .split(".")[0];
  }

  const threadId = ctx.message?.message_thread_id ?? template.thread_id;

  const raffle = db.createRaffle({
    chat_id: ctx.chat.id,
    thread_id: threadId,
    creator_id: userId,
    creator_name: displayName,
    title: template.title,
    description: "",
    prize: template.prize,
    prizes: template.prizes,
    max_entries: template.max_entries,
    max_winners: template.max_winners,
    ends_at: endsAt,
    starts_at: null,
    display_timezone: db.getChatTimezone(ctx.chat!.id),
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

  const lang = db.getChatLanguage(ctx.chat.id);
  const botUsername = ctx.me.username;

  const keyboard = buildRaffleKeyboard(raffle, 0, lang, botUsername);

  const msgId = await sendRafflePost(
    ctx.api,
    ctx.chat.id,
    "open",
    formatRaffleMessage(raffle, 0, lang),
    keyboard,
    null,
    raffle.thread_id
  );

  if (msgId) {
    db.updateRaffleMessageId(raffle.id, msgId);
  }
}

// /recurring - Toggle recurring on/off for a template
export async function handleRecurring(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can manage recurring raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/recurring(@\w+)?/i, "").trim();

  if (!args) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  const parts = args.split(/\s+/);
  const action = parts.pop()?.toLowerCase();
  const name = parts.join(" ");

  if (!name || (action !== "on" && action !== "off")) {
    await replyPrivately(ctx,
      "Usage: <code>/recurring TemplateName on</code> or <code>/recurring TemplateName off</code>",
      { parse_mode: "HTML" });
    return;
  }

  const template = db.getTemplateByName(ctx.chat.id, name);
  if (!template) {
    await replyPrivately(ctx,
      `Template "${escapeHtml(name)}" not found.`,
      { parse_mode: "HTML" });
    return;
  }

  if (!template.recurring_interval_minutes) {
    await replyPrivately(ctx,
      `Template "${escapeHtml(name)}" doesn't have a recurring interval set.\nRe-create it with <code>recurring:TIME</code> parameter.`,
      { parse_mode: "HTML" });
    return;
  }

  if (action === "on") {
    const nextRun = new Date(Date.now() + template.recurring_interval_minutes * 60 * 1000);
    const nextRunStr = nextRun
      .toISOString()
      .replace("T", " ")
      .replace("Z", "")
      .split(".")[0];
    db.setRecurringActive(template.id, true, nextRunStr);
    await replyPrivately(ctx,
      `🔄 Recurring <b>activated</b> for "${escapeHtml(name)}".\nNext raffle in ${template.recurring_interval_minutes} minutes.`,
      { parse_mode: "HTML" });
  } else {
    db.setRecurringActive(template.id, false, null);
    await replyPrivately(ctx,
      `⏸ Recurring <b>paused</b> for "${escapeHtml(name)}".`,
      { parse_mode: "HTML" });
  }
}

// /editraffle - Edit an active raffle's settings
export async function handleEditRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can edit raffles.");
    return;
  }

  const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);
  if (openRaffles.length === 0) {
    await replyPrivately(ctx, "No open raffles to edit.");
    return;
  }

  // Check if a specific raffle ID was provided
  const text = ctx.message?.text || "";
  const args = text.replace(/^\/editraffle(@\w+)?/i, "").trim();
  const raffleId = parseInt(args, 10);

  if (!isNaN(raffleId)) {
    const raffle = openRaffles.find((r) => r.id === raffleId);
    if (raffle) {
      await startEditWizard(ctx, raffle.id, ctx.chat.id);
      return;
    }
  }

  // If only one open raffle, edit it directly
  if (openRaffles.length === 1) {
    await startEditWizard(ctx, openRaffles[0].id, ctx.chat.id);
    return;
  }

  // Multiple raffles — show selection in DM
  try {
    const kb = new InlineKeyboard();
    for (const r of openRaffles) {
      kb.text(`${escapeHtml(r.title)} (#${r.id})`, `edit_pick_${r.id}`).row();
    }

    await ctx.api.sendMessage(
      userId,
      `✏️ <b>Which raffle do you want to edit?</b>`,
      { parse_mode: "HTML", reply_markup: kb }
    );

    const notice = await ctx.reply(
      `✏️ Check your DMs @${ctx.from!.username || ctx.from!.first_name} — pick a raffle to edit.`
    );
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, notice.message_id);
      } catch {}
    }, 5000);
  } catch {
    await replyPrivately(ctx, "Please start a DM with me first, then try /editraffle again.");
  }
}

// /language - Set the bot language for this chat
export async function handleLanguage(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can change the language.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/language(@\w+)?/i, "").trim().toLowerCase();

  const current = db.getChatLanguage(ctx.chat.id);

  if (!args) {
    const langs = getAvailableLanguages();
    let msg = `🌐 <b>${t(current, "misc.lang_current", { lang: getLanguageName(current) })}</b>\n\n`;
    msg += `<b>Available languages:</b>\n`;
    for (const l of langs) {
      const marker = l.code === current ? " ✅" : "";
      msg += `• <code>/language ${l.code}</code> — ${l.name}${marker}\n`;
    }
    await replyPrivately(ctx, msg, { parse_mode: "HTML" });
    return;
  }

  const supported = db.getSupportedLanguages();
  if (!supported.includes(args)) {
    await replyPrivately(ctx,
      `Language "${escapeHtml(args)}" is not supported.\nUse /language to see available options.`,
      { parse_mode: "HTML" });
    return;
  }

  db.setChatLanguage(ctx.chat.id, args);
  const langName = getLanguageName(args);
  await replyPrivately(ctx,
    `🌐 ${t(args, "misc.lang_set", { lang: langName })}`,
    { parse_mode: "HTML" });
}

// /timezone - View or set the chat's timezone (admin only in groups)
export async function handleTimezone(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can change the timezone.");
    return;
  }

  const { resolveTimezone, formatInTimezone } = await import("./timezone");

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/timezone(@\w+)?/i, "").trim();
  const current = db.getChatTimezone(ctx.chat.id);

  if (!args) {
    const nowInTz = formatInTimezone(new Date(), current);
    const msg =
      `🕐 <b>Group timezone:</b> <code>${escapeHtml(current)}</code>\n` +
      `Current time: <b>${escapeHtml(nowInTz)}</b>\n\n` +
      `<b>Set with:</b> <code>/timezone &lt;name&gt;</code>\n\n` +
      `<b>Common options:</b>\n` +
      `• <code>/timezone UTC</code>\n` +
      `• <code>/timezone EST</code> (or <code>America/New_York</code>)\n` +
      `• <code>/timezone CST</code> (or <code>America/Chicago</code>)\n` +
      `• <code>/timezone MST</code> (or <code>America/Denver</code>)\n` +
      `• <code>/timezone PST</code> (or <code>America/Los_Angeles</code>)\n` +
      `• <code>/timezone Europe/London</code>\n` +
      `• <code>/timezone Asia/Tokyo</code>\n\n` +
      `<i>Any IANA timezone name works. Daylight saving is handled automatically.</i>`;
    await replyPrivately(ctx, msg, { parse_mode: "HTML" });
    return;
  }

  const resolved = resolveTimezone(args);
  if (!resolved) {
    await replyPrivately(ctx,
      `Timezone "<code>${escapeHtml(args)}</code>" is not recognized.\n\n` +
        `Try a common name like <code>EST</code>, <code>PST</code>, or an IANA name like <code>America/New_York</code>.\n` +
        `Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return;
  }

  db.setChatTimezone(ctx.chat.id, resolved);
  const nowInTz = formatInTimezone(new Date(), resolved);
  await replyPrivately(ctx,
    `✅ Timezone set to <code>${escapeHtml(resolved)}</code>.\n` +
      `Current time: <b>${escapeHtml(nowInTz)}</b>\n\n` +
      `All future raffles in this group will use this timezone for scheduling and display.`,
    { parse_mode: "HTML" });
}

// --- Callback query handlers ---

export async function handleEnterCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("enter_", ""), 10);
  if (isNaN(raffleId)) return;

  const userId = ctx.from!.id;
  const userName = ctx.from!.username || "";
  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  // --- Entry verification checks ---
  const raffle = db.getRaffleById(raffleId);
  if (raffle) {
    // Require username check
    if (raffle.require_username && !ctx.from!.username) {
      await ctx.answerCallbackQuery({
        text: "⚠️ You need a Telegram username to enter this raffle. Set one in Settings → Username.",
        show_alert: true,
      });
      return;
    }

    // Account age check (estimated from user ID)
    if (raffle.min_account_age_days > 0) {
      const estimatedAge = estimateAccountAgeDays(userId);
      if (estimatedAge !== null && estimatedAge < raffle.min_account_age_days) {
        await ctx.answerCallbackQuery({
          text: `⚠️ Your account must be at least ${raffle.min_account_age_days} day${raffle.min_account_age_days > 1 ? "s" : ""} old to enter.`,
          show_alert: true,
        });
        return;
      }
    }

    // Winner cooldown check
    if (raffle.winner_cooldown > 0) {
      const recentWin = db.getRecentWin(raffle.chat_id, userId, raffle.winner_cooldown);
      if (recentWin) {
        await ctx.answerCallbackQuery({
          text: `⚠️ Recent winners can't enter yet. You won "${recentWin}" recently. Try again after more raffles complete!`,
          show_alert: true,
        });
        return;
      }
    }
  }

  const result = db.addEntry(raffleId, userId, userName, displayName);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  const entryLang = chatId ? db.getChatLanguage(chatId) : "en";

  if (result.success) {
    await ctx.answerCallbackQuery({ text: `🎟 ${t(entryLang, "entry.success")}` });
    // Debounced — batches rapid entries into one message edit
    debouncedUpdateRafflePost(ctx, raffleId);

    // Referral link is now handled via the "Get Referral Link" button on the raffle post
    // which deep-links to the bot DM where the link is generated on demand

    // Auto-draw when max entries reached
    if (result.maxReached) {
      // Cancel pending debounce — auto-draw does a direct update
      const pending = pendingPostUpdates.get(raffleId);
      if (pending) { clearTimeout(pending.timer); pendingPostUpdates.delete(raffleId); }

      const raffle = db.getRaffleById(raffleId);
      if (raffle && raffle.status === "open") {
        const lang = db.getChatLanguage(raffle.chat_id);
        const entries = db.getEntriesForRaffle(raffleId);
        const entryNames = entries.map((e) => e.user_display_name);
        const winners = db.selectWinners(raffleId);

        // Countdown animation (if animation enabled)
        if (entryNames.length >= 1 && raffle.show_animation) {
          await sendWheelSpin(ctx.api, raffle.chat_id, raffle.thread_id);
        }

        // Announce winners with embedded "WINNERS DRAWN" banner
        await sendWinnerPost(ctx.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);

        db.markRaffleDrawn(raffleId);
        db.markRaffleAnnounced(raffleId);
        await revokeReferralInviteLinks(ctx.api, raffleId);
        await updateRafflePost(ctx, raffleId);
        await notifyWinnersAndCreator(ctx.api, raffle, winners);
      }
    }
  } else {
    await ctx.answerCallbackQuery({
      text: result.reason || "Could not enter.",
      show_alert: true,
    });
  }
}

export async function handleLeaveCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("leave_", ""), 10);
  if (isNaN(raffleId)) return;

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== "open") {
    await ctx.answerCallbackQuery({
      text: "This raffle is no longer open.",
      show_alert: true,
    });
    return;
  }

  const removed = db.removeEntry(raffleId, ctx.from!.id);
  const leaveLang = raffle ? db.getChatLanguage(raffle.chat_id) : "en";

  if (removed) {
    await ctx.answerCallbackQuery({ text: t(leaveLang, "entry.left") });
    // Debounced — batches rapid leaves into one message edit
    debouncedUpdateRafflePost(ctx, raffleId);
  } else {
    await ctx.answerCallbackQuery({
      text: t(leaveLang, "entry.not_in"),
      show_alert: true,
    });
  }
}

export async function handleEntriesCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace(/^entries_/, "").split("_")[0], 10);
  if (isNaN(raffleId)) return;

  const raffle = db.getRaffleById(raffleId);

  // Anonymous mode: hide entry names until drawn
  if (raffle && raffle.anonymous && raffle.status !== "drawn") {
    const count = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : db.getEntryCount(raffleId);
    await ctx.answerCallbackQuery({
      text: count === 0
        ? "No entries yet. Be the first!"
        : `${count} entries so far. Names hidden until draw!`,
      show_alert: true,
    });
    return;
  }

  const totalParticipants = db.getEntryCount(raffleId);

  if (totalParticipants === 0) {
    await ctx.answerCallbackQuery({
      text: "No entries yet. Be the first!",
      show_alert: true,
    });
    return;
  }

  // Build entries list - Telegram popup limit is ~200 chars.
  const recentEntries = db.getRecentEntriesForRaffle(raffleId, 20);

  // If referrals are enabled, show bonus entries next to names
  const showBonus = raffle && raffle.referral_enabled;
  const names = recentEntries.map((e, i) => {
    const num = totalParticipants - i;
    if (showBonus) {
      return e.bonus_entries > 0
        ? `${num}. ${e.user_display_name} (+${e.bonus_entries})`
        : `${num}. ${e.user_display_name}`;
    }
    return `${num}. ${e.user_display_name}`;
  });

  const totalCount = raffle && raffle.referral_enabled
    ? db.getTotalEntryCount(raffleId)
    : totalParticipants;
  let message = `📋 Entries (${totalCount}) - Recent:\n`;

  for (const name of names) {
    if ((message + name + "\n").length > 195) {
      message += "...";
      break;
    }
    message += name + "\n";
  }

  await ctx.answerCallbackQuery({
    text: message.trim(),
    show_alert: true,
  });
}

// --- Utility ---

// Track which raffles are photo-based vs text-only to avoid wasted API calls
const raffleIsPhotoMsg = new Map<number, boolean>();

async function updateRafflePost(ctx: Context, raffleId: number): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || !raffle.message_id) return;

  const count = db.getEntryCount(raffleId);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;

  const lang = db.getChatLanguage(raffle.chat_id);
  const botUsername = ctx.me.username;

  try {
    if (raffle.status === "open") {
      const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);
      const caption = formatRaffleMessage(raffle, count, lang);
      const isPhoto = raffleIsPhotoMsg.get(raffleId);

      if (isPhoto === false) {
        // Known text-only — skip editMessageCaption entirely
        await ctx.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
        return;
      }

      try {
        await ctx.api.editMessageCaption(raffle.chat_id, raffle.message_id, { caption, parse_mode: "HTML", reply_markup: keyboard });
        raffleIsPhotoMsg.set(raffleId, true);
      } catch {
        try {
          await ctx.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
          raffleIsPhotoMsg.set(raffleId, false);
        } catch { /* unchanged or deleted */ }
      }
    } else {
      // Raffle is closed or drawn - remove entry buttons and swap banner to "closed"
      let text = formatRaffleMessage(raffle, count, lang);

      if (raffle.status === "drawn") {
        const winners = db.getWinnersForRaffle(raffleId);
        if (winners.length > 0) {
          const winnerLabel = winners.length > 1
            ? t(lang, "winner.label_plural")
            : t(lang, "winner.label");
          text += `\n\n🏆 <b>${winnerLabel}:</b>\n`;
          winners.forEach((w) => {
            const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
            if (w.prize) {
              text += `  🎁 ${mention} — ${escapeHtml(w.prize)}\n`;
            } else {
              text += `  • ${mention}\n`;
            }
          });
        }
      }

      // Try to swap the banner to "closed" using editMessageMedia
      const closedBannerFileId = await getBannerFileId(ctx.api, raffle.chat_id, "closed");
      if (closedBannerFileId) {
        try {
          await ctx.api.editMessageMedia(
            raffle.chat_id,
            raffle.message_id,
            {
              type: "photo",
              media: closedBannerFileId,
              caption: text,
              parse_mode: "HTML",
            }
          );
          return; // Success - exit early
        } catch (err) {
          console.error(`Failed to swap banner to closed:`, err);
          // editMessageMedia failed, fall back to editMessageCaption
        }
      } else {
        console.log(`No closed banner file_id available for chat ${raffle.chat_id}`);
      }

      // Fallback: just update the caption (banner stays as "open")
      await ctx.api.editMessageCaption(
        raffle.chat_id,
        raffle.message_id,
        { caption: text, parse_mode: "HTML" }
      );
    }
  } catch {
    // Message may have been deleted or too old to edit
  }
}

/**
 * Revoke all referral invite links for a raffle, if revoke_referral_links is enabled.
 * Silently skips links that are already revoked or invalid.
 */
export async function revokeReferralInviteLinks(
  api: { revokeChatInviteLink: (chatId: number, inviteLink: string) => Promise<unknown> },
  raffleId: number
): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle) return;
  if (!raffle.referral_enabled || !raffle.revoke_referral_links) return;

  const links = db.getReferralLinksForRaffle(raffleId);
  if (links.length === 0) return;

  // Revoke in parallel batches of 5 to avoid rate limits
  let revoked = 0;
  const BATCH_SIZE = 5;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((link) => api.revokeChatInviteLink(link.chat_id, link.invite_link))
    );
    revoked += results.filter((r) => r.status === "fulfilled").length;
  }

  if (revoked > 0) {
    console.log(`Revoked ${revoked}/${links.length} referral invite links for raffle ${raffleId}`);
  }
}

/**
 * DM each winner telling them what they won, and DM the raffle creator
 * (and sponsor info) with the full results.
 */
export async function notifyWinnersAndCreator(
  api: { sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown>; getChat: (chatId: number) => Promise<{ title?: string; username?: string }> },
  raffle: { id: number; chat_id: number; title: string; creator_id: number; creator_name: string; sponsor_name: string | null; message_id: number | null },
  winners: Array<{ user_id: number; user_display_name: string; prize: string; position: number }>
): Promise<void> {
  const title = escapeHtml(raffle.title);

  // Resolve group title + public username (if any) for link building
  let groupTitle = "the group";
  let groupUsername: string | null = null;
  try {
    const chat = await api.getChat(raffle.chat_id);
    if (chat.title) groupTitle = chat.title;
    if (chat.username) groupUsername = chat.username;
  } catch {
    // Bot may have been kicked since the draw — we'll fall back to plain text
  }

  // Build a link straight to the raffle post.
  //   - Public groups: https://t.me/<username>/<msgId>
  //   - Private supergroups: https://t.me/c/<shortId>/<msgId>  (only opens for members)
  let raffleLink: string | null = null;
  if (raffle.message_id) {
    if (groupUsername) {
      raffleLink = `https://t.me/${groupUsername}/${raffle.message_id}`;
    } else {
      raffleLink = buildMessageLink(raffle.chat_id, raffle.message_id);
    }
  }
  const groupLink: string | null = raffleLink; // same destination; both nav to the chat

  // Sponsor contact line (optional, separate from group info)
  let sponsorLine = "";
  if (raffle.sponsor_name) {
    const sponsor = raffle.sponsor_name.trim();
    if (sponsor.startsWith("@")) {
      const username = sponsor.replace(/^@/, "");
      sponsorLine = `\n💎 <b>Sponsor:</b> <a href="https://t.me/${escapeHtml(username)}">${escapeHtml(sponsor)}</a> — contact them to claim your prize!`;
    } else {
      sponsorLine = `\n💎 <b>Sponsor:</b> ${escapeHtml(sponsor)}`;
    }
  }

  // Group line — ALWAYS present so winners know where they won, even when sponsored.
  // Includes a link to the raffle post when we can build one.
  const groupNameEsc = escapeHtml(groupTitle);
  const groupLine = groupLink
    ? `\n📍 <b>Group:</b> <a href="${groupLink}">${groupNameEsc}</a>`
    : `\n📍 <b>Group:</b> ${groupNameEsc}`;

  const raffleLinkLine = raffleLink
    ? `\n🔗 <a href="${raffleLink}">View the raffle post</a>`
    : "";

  // DM all winners concurrently
  const dmResults = await Promise.allSettled(
    winners.map(async (w) => {
      let winnerMsg = `🎉 <b>Congratulations!</b>\n\n`;
      winnerMsg += `You won in the raffle <b>${title}</b>!`;
      if (w.prize) {
        winnerMsg += `\n🎁 <b>Your prize:</b> ${escapeHtml(w.prize)}`;
      }
      winnerMsg += "\n";
      winnerMsg += groupLine;
      if (sponsorLine) winnerMsg += sponsorLine;
      winnerMsg += raffleLinkLine;
      await api.sendMessage(w.user_id, winnerMsg, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return w.user_display_name;
    })
  );

  const failedDmWinners = dmResults
    .map((r, i) => r.status === "rejected" ? winners[i].user_display_name : null)
    .filter((name): name is string => name !== null);

  if (failedDmWinners.length > 0) {
    console.log(`Could not DM winners: ${failedDmWinners.join(", ")}`);
  }

  // DM the creator with full results
  try {
    let creatorMsg = `🏆 <b>Raffle Results: ${title}</b>\n\n`;
    if (winners.length === 0) {
      creatorMsg += `No winners were selected (no entries).`;
    } else {
      creatorMsg += `<b>Winners:</b>\n`;
      for (const w of winners) {
        const name = escapeHtml(w.user_display_name);
        if (w.prize) {
          creatorMsg += `  ${w.position}. ${name} — ${escapeHtml(w.prize)}\n`;
        } else {
          creatorMsg += `  ${w.position}. ${name}\n`;
        }
      }
    }
    if (raffle.sponsor_name) {
      creatorMsg += `\n💎 Sponsor: ${escapeHtml(raffle.sponsor_name)}`;
    }
    await api.sendMessage(raffle.creator_id, creatorMsg, { parse_mode: "HTML" });
  } catch {
    // Creator may not have started the bot
  }
}

// Build stats message — shared by /stats command and weekly auto-report
export function buildStatsMessage(): string {
  const stats = db.getBotStats();

  // Get groups from the bot_groups tracking table
  const allGroups = db.getActiveBotGroups();
  const adminGroups = db.getAdminBotGroups();

  let msg = `📊 <b>Bot Statistics</b>\n\n`;

  msg += `<b>Usage:</b>\n`;
  msg += `  👥 Groups (total): <b>${allGroups.length}</b>\n`;
  msg += `  🛡 Groups (admin): <b>${adminGroups.length}</b>\n`;
  msg += `  🧑 Unique creators: <b>${stats.totalCreators}</b>\n`;
  msg += `  🎟 Unique participants: <b>${stats.totalParticipants}</b>\n\n`;

  msg += `<b>Raffles:</b>\n`;
  msg += `  📋 Total: <b>${stats.totalRaffles}</b>\n`;
  msg += `  🟢 Active: <b>${stats.activeRaffles}</b> <i>(use /active for the list)</i>\n`;
  msg += `  🏆 Drawn: <b>${stats.drawnRaffles}</b>\n\n`;

  msg += `<b>Entries:</b>\n`;
  msg += `  📝 Total entries: <b>${stats.totalEntries}</b>\n`;
  msg += `  🏆 Total winners: <b>${stats.totalWinners}</b>\n\n`;

  msg += `<b>Last 7 days:</b>\n`;
  msg += `  📋 Raffles created: <b>${stats.rafflesLast7Days}</b>\n`;
  msg += `  📝 Entries: <b>${stats.entriesLast7Days}</b>\n`;

  if (adminGroups.length > 0) {
    msg += `\n<b>🛡 Admin Groups:</b>\n`;
    for (const g of adminGroups) {
      msg += `  • ${escapeHtml(g.title)}\n`;
    }
  }

  const memberOnly = allGroups.filter((g) => g.bot_status === "member");
  if (memberOnly.length > 0) {
    msg += `\n<b>👤 Member Only (no admin):</b>\n`;
    for (const g of memberOnly) {
      msg += `  • ${escapeHtml(g.title)}\n`;
    }
  }

  return msg;
}

/**
 * Split a long HTML-formatted message into chunks that fit within Telegram's 4096 char limit.
 * Splits at safe boundaries: blank-line section breaks first, then single newlines if needed.
 */
export function chunkMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a blank-line boundary within the limit
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen / 2) {
      // Fall back to single newline if blank-line split would lose too much
      splitAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitAt < maxLen / 2) {
      // Last resort: hard split at maxLen
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// /stats - Bot-wide statistics (owner only)
export async function handleStats(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    // Silently ignore — don't reveal the command exists
    return;
  }

  const msg = buildStatsMessage();
  const chunks = chunkMessage(msg);

  // Send all chunks as DMs to the owner; fall back to chat reply if DM fails
  let useFallback = false;
  for (const chunk of chunks) {
    try {
      if (useFallback) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } else {
        await ctx.api.sendMessage(userId, chunk, { parse_mode: "HTML" });
      }
    } catch (err) {
      // If first send fails (DM blocked), retry the rest in chat
      if (!useFallback) {
        useFallback = true;
        try {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } catch (err2) {
          console.error("Stats: failed to send chunk in chat fallback:", err2);
        }
      } else {
        console.error("Stats: failed to send chunk:", err);
      }
    }
    // Tiny gap to avoid per-chat rate limits when chunks > 1
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /health - Bot health snapshot (owner only, hidden)
export async function handleHealth(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    return; // Silently ignore
  }

  const health = db.getAnnouncementHealth();
  const stats = db.getBotStats();
  const groups = db.getActiveBotGroups();
  const adminCount = groups.filter((g) => g.bot_status === "administrator").length;
  const memberCount = groups.length - adminCount;

  // Find the worst-stuck raffle (oldest unannounced)
  const worst = db.getOldestUnannouncedRaffles(5);

  // Bot uptime — process.uptime returns seconds
  const uptimeSec = Math.floor(process.uptime());
  const uptimeStr =
    uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m`
      : uptimeSec < 86400
      ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
      : `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`;

  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const overall =
    health.stuckOver1h > 0 || health.permanentlyFailed > 5
      ? "🔴 <b>Issues detected</b>"
      : health.stuckOver15min > 0
      ? "🟡 <b>Minor issues</b>"
      : "🟢 <b>Healthy</b>";

  let msg = `${overall}\n\n`;
  msg += `<b>🤖 Bot</b>\n`;
  msg += `  Uptime: ${uptimeStr}\n`;
  msg += `  Memory: ${memMb} MB\n\n`;

  msg += `<b>📊 Activity</b>\n`;
  msg += `  Active raffles: ${stats.activeRaffles}\n`;
  msg += `  Tracked groups: ${groups.length} (${adminCount} admin / ${memberCount} member)\n\n`;

  msg += `<b>📣 Announcements</b>\n`;
  msg += `  Pending: ${health.totalUnannounced}\n`;
  msg += `  Stuck >15 min: ${health.stuckOver15min === 0 ? "0 ✅" : `${health.stuckOver15min} ⚠️`}\n`;
  msg += `  Stuck >1 hour: ${health.stuckOver1h === 0 ? "0 ✅" : `${health.stuckOver1h} 🔴`}\n`;
  msg += `  Gave up on: ${health.permanentlyFailed}\n\n`;

  const jobs = getJobStats();
  msg += `<b>⚙️ Background Jobs</b>\n`;
  msg += `  Pending: ${jobs.pending}\n`;
  msg += `  Running: ${jobs.running}\n`;
  msg += `  Done (24h): ${jobs.doneLast24h}\n`;
  msg += `  Failed: ${jobs.failed === 0 ? "0 ✅" : `${jobs.failed} ⚠️`}\n\n`;

  // Backup status
  const BACKUP_DIR = "/data/backups";
  msg += `<b>💾 Backups</b>\n`;
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith("raffle.db.") && f.endsWith(".bak"))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs,
          size: fs.statSync(path.join(BACKUP_DIR, f)).size,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        msg += `  ⚠️ No backups yet (waiting for first hourly run)\n`;
      } else {
        const latest = files[0];
        const ageMin = Math.floor((Date.now() - latest.mtime) / 60_000);
        const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
        const totalMb = (files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1);
        const ageIcon = ageMin > 90 ? "🔴" : ageMin > 65 ? "🟡" : "✅";
        msg += `  Last backup: ${ageStr} ${ageIcon}\n`;
        msg += `  Count: ${files.length} files (${totalMb} MB total)\n`;
      }
    } else {
      msg += `  ⚠️ Backup directory not found\n`;
    }
  } catch (err) {
    msg += `  ⚠️ Could not read backups: ${escapeHtml(String((err as Error).message || err))}\n`;
  }

  if (worst.length > 0) {
    msg += `\n<b>🔍 Oldest pending</b>\n`;
    for (const r of worst) {
      msg += `  • <code>${r.id}</code> ${escapeHtml(r.title.slice(0, 40))} — ${r.announce_attempts} attempts\n`;
      msg += `     drawn ${r.drawn_at} UTC, chat <code>${r.chat_id}</code>\n`;
    }
  }

  const chunks = chunkMessage(msg);
  let useFallback = false;
  for (const chunk of chunks) {
    try {
      if (useFallback) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } else {
        await ctx.api.sendMessage(userId, chunk, { parse_mode: "HTML" });
      }
    } catch {
      if (!useFallback) {
        useFallback = true;
        try {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } catch (err2) {
          console.error("Health: failed chat fallback:", err2);
        }
      }
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /metrics - Bot activity counters since process start (owner only, hidden)
export async function handleMetrics(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) return;

  const snap = metrics.snapshot();

  const uptimeStr =
    snap.uptimeSec < 60
      ? `${snap.uptimeSec}s`
      : snap.uptimeSec < 3600
      ? `${Math.floor(snap.uptimeSec / 60)}m`
      : snap.uptimeSec < 86400
      ? `${Math.floor(snap.uptimeSec / 3600)}h ${Math.floor((snap.uptimeSec % 3600) / 60)}m`
      : `${Math.floor(snap.uptimeSec / 86400)}d ${Math.floor((snap.uptimeSec % 86400) / 3600)}h`;

  // Aggregate stats
  const totalApiCalls = Object.values(snap.apiCalls).reduce((a, b) => a + b, 0);
  const totalErrors = Object.values(snap.apiErrors).reduce((a, b) => a + b, 0);
  const totalCommands = Object.values(snap.commands).reduce((a, b) => a + b, 0);
  const errorRate = totalApiCalls > 0 ? ((totalErrors / totalApiCalls) * 100).toFixed(2) : "0.00";

  let msg = `📊 <b>Bot Metrics</b>\n`;
  msg += `<i>Since process start — restart to reset</i>\n\n`;

  msg += `<b>📈 Overview</b>\n`;
  msg += `  Uptime: ${uptimeStr}\n`;
  msg += `  Started: <code>${snap.startedAt}</code>\n`;
  msg += `  API calls: ${totalApiCalls.toLocaleString()}\n`;
  msg += `  API errors: ${totalErrors.toLocaleString()} (${errorRate}%)\n`;
  msg += `  Commands: ${totalCommands.toLocaleString()}\n`;
  msg += `  Rate-limit hits: ${snap.rateLimitHits}\n`;
  msg += `  Owner alerts sent: ${snap.ownerAlertsSent}\n\n`;

  // Top 8 API methods
  const apiSorted = Object.entries(snap.apiCalls).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (apiSorted.length > 0) {
    msg += `<b>🌐 Top API Calls</b>\n`;
    for (const [method, count] of apiSorted) {
      msg += `  ${method}: <b>${count.toLocaleString()}</b>\n`;
    }
    msg += `\n`;
  }

  // Top error codes
  const errSorted = Object.entries(snap.apiErrors).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (errSorted.length > 0) {
    msg += `<b>⚠️ API Errors by method:code</b>\n`;
    for (const [key, count] of errSorted) {
      msg += `  <code>${escapeHtml(key)}</code>: ${count}\n`;
    }
    msg += `\n`;
  }

  // Top commands
  const cmdSorted = Object.entries(snap.commands).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (cmdSorted.length > 0) {
    msg += `<b>💬 Top Commands</b>\n`;
    for (const [cmd, count] of cmdSorted) {
      msg += `  /${escapeHtml(cmd)}: ${count}\n`;
    }
    msg += `\n`;
  }

  // Latency stats
  const lat = computeLatencyStats(snap.apiLatencyMs);
  const latEntries = Object.entries(lat).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  if (latEntries.length > 0) {
    msg += `<b>⚡ API Latency (recent ${snap.apiLatencyMs.length} samples)</b>\n`;
    for (const [method, stats] of latEntries) {
      const warn = stats.p95 > 2000 ? " ⚠️" : "";
      msg += `  ${method}: p50 <b>${stats.p50}ms</b>, p95 <b>${stats.p95}ms</b>${warn}\n`;
    }
  }

  try {
    await ctx.api.sendMessage(userId, msg, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}

// /active — List all active raffles across all groups (hidden, not in BotFather menu)
export async function handleActive(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const groups = db.getActiveRafflesByGroup();

  if (groups.length === 0) {
    await ctx.reply("📭 No active raffles right now.");
    return;
  }

  let totalRaffles = 0;
  const sections: string[] = [];

  for (const group of groups) {
    let groupTitle = `Chat ${group.chat_id}`;
    try {
      const chat = await ctx.api.getChat(group.chat_id);
      if ("title" in chat && chat.title) {
        groupTitle = chat.title;
      }
    } catch {
      // Can't resolve name — use chat ID
    }

    let section = `<b>📍 ${escapeHtml(groupTitle)}</b>\n`;

    for (const raffle of group.raffles) {
      totalRaffles++;
      const entryCount = db.getEntryCount(raffle.id);
      const totalCount = raffle.referral_enabled ? db.getTotalEntryCount(raffle.id) : entryCount;

      let line = `  🎟 <b>${escapeHtml(raffle.title)}</b> — ${totalCount} entries`;
      if (raffle.max_winners > 1) {
        line += ` (${raffle.max_winners} winners)`;
      }
      if (raffle.ends_at) {
        const endsDate = new Date(raffle.ends_at + "Z");
        const remaining = endsDate.getTime() - Date.now();
        if (remaining > 0) {
          line += ` — ${formatCountdown(endsDate)} left`;
        } else {
          line += ` — <i>expired, pending draw</i>`;
        }
      } else {
        line += ` — no end time`;
      }
      if (raffle.message_id) {
        const link = buildMessageLink(raffle.chat_id, raffle.message_id);
        if (link) {
          line += ` (<a href="${link}">view</a>)`;
        }
      }
      section += line + "\n";
    }

    sections.push(section);
  }

  const header = `📊 <b>Active Raffles: ${totalRaffles} across ${groups.length} group${groups.length === 1 ? "" : "s"}</b>\n\n`;
  const msg = header + sections.join("\n");

  const chunks = chunkMessage(msg);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error("Active: failed to send chunk:", err);
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /referralstats — Show referral link stats for active raffles (owner only)
export async function handleReferralStats(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    return;
  }

  // Get all open raffles with referrals enabled
  const allOpen = db.getActiveRafflesByGroup();
  const referralRaffles: Array<{ raffle: ReturnType<typeof db.getRaffleById>; links: ReturnType<typeof db.getReferralLinksForRaffle>; entryCount: number; totalCount: number }> = [];

  for (const group of allOpen) {
    for (const raffle of group.raffles) {
      if (raffle.referral_enabled) {
        const links = db.getReferralLinksForRaffle(raffle.id);
        const entryCount = db.getEntryCount(raffle.id);
        const totalCount = db.getTotalEntryCount(raffle.id);
        referralRaffles.push({ raffle, links, entryCount, totalCount });
      }
    }
  }

  if (referralRaffles.length === 0) {
    try {
      await ctx.api.sendMessage(userId, "No active raffles with referrals enabled.", { parse_mode: "HTML" });
    } catch {
      await ctx.reply("No active raffles with referrals enabled.");
    }
    return;
  }

  let msg = `🔗 <b>Referral Stats</b>\n`;

  for (const { raffle, links, entryCount, totalCount } of referralRaffles) {
    if (!raffle) continue;
    const groupInfo = db.getActiveBotGroups().find((g) => g.chat_id === raffle.chat_id);
    const groupName = groupInfo ? groupInfo.title : `Chat ${raffle.chat_id}`;
    const totalBonuses = links.reduce((sum, l) => sum + l.bonus_entries, 0);

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📝 <b>${escapeHtml(raffle.title)}</b>\n`;
    msg += `💬 ${escapeHtml(groupName)}\n`;
    msg += `👥 Entries: <b>${entryCount}</b> unique · <b>${totalCount}</b> effective\n`;
    msg += `🔗 Links created: <b>${links.length}</b>\n`;
    msg += `⭐ Bonus entries: <b>${totalBonuses}</b>\n`;

    const withReferrals = links.filter((l) => l.bonus_entries > 0);
    if (withReferrals.length > 0) {
      msg += `\n<b>Leaderboard:</b>\n`;
      for (const l of withReferrals) {
        msg += `  🏅 ${escapeHtml(l.user_display_name)} — <b>${l.bonus_entries}</b> referral${l.bonus_entries !== 1 ? "s" : ""}\n`;
      }
    }

    const noReferrals = links.filter((l) => l.bonus_entries === 0);
    if (noReferrals.length > 0) {
      msg += `\n<b>Links created (0 referrals):</b>\n`;
      for (const l of noReferrals) {
        msg += `  • ${escapeHtml(l.user_display_name)}\n`;
      }
    }
  }

  try {
    await ctx.api.sendMessage(userId, msg, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}

// /groupstats — Show raffle stats for this group (admin only)
export async function handleGroupStats(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    return; // silently ignore for non-admins
  }

  const stats = db.getGroupStats(ctx.chat.id);

  let msg = `📊 <b>Group Raffle Stats</b>\n\n`;

  msg += `<b>Overview:</b>\n`;
  msg += `  📋 Total raffles: <b>${stats.totalRaffles}</b>\n`;
  msg += `  🟢 Active: <b>${stats.activeRaffles}</b>\n`;
  msg += `  🏆 Drawn: <b>${stats.drawnRaffles}</b>\n`;
  msg += `  👥 Unique participants: <b>${stats.uniqueParticipants}</b>\n`;
  msg += `  📊 Avg entries/raffle: <b>${stats.avgEntriesPerRaffle}</b>\n\n`;

  msg += `<b>Totals:</b>\n`;
  msg += `  📝 Entries: <b>${stats.totalEntries}</b>\n`;
  msg += `  🏆 Winners: <b>${stats.totalWinners}</b>\n\n`;

  msg += `<b>Last 7 days:</b>\n`;
  msg += `  📋 Raffles: <b>${stats.rafflesLast7Days}</b>\n`;
  msg += `  📝 Entries: <b>${stats.entriesLast7Days}</b>\n`;

  if (stats.topParticipants.length > 0) {
    msg += `\n<b>🔥 Most Active:</b>\n`;
    stats.topParticipants.forEach((p, i) => {
      msg += `  ${i + 1}. ${escapeHtml(p.name)} — ${p.count} entries\n`;
    });
  }

  if (stats.topWinners.length > 0) {
    msg += `\n<b>🏆 Top Winners:</b>\n`;
    stats.topWinners.forEach((w, i) => {
      msg += `  ${i + 1}. ${escapeHtml(w.name)} — ${w.count} win${w.count > 1 ? "s" : ""}\n`;
    });
  }

  await replyPrivately(ctx, msg, { parse_mode: "HTML" });
}

// /bugreport — Start a bug report (works anywhere)
export async function handleBugReport(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const { startBugReport } = await import("./wizard");

  const chatId = ctx.chat?.id || ctx.from.id;
  let chatTitle = "Direct Message";
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    try {
      const chat = await ctx.api.getChat(chatId);
      if ("title" in chat) chatTitle = chat.title || chatTitle;
    } catch {}
  }

  const started = await startBugReport(ctx, chatId, chatTitle);
  if (started) {
    if (ctx.chat?.type !== "private") {
      const notice = await ctx.reply(
        `📋 Check your DMs @${ctx.from.username || ctx.from.first_name} — bug report form is there.`
      );
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(chatId, notice.message_id);
        } catch {}
      }, 5000);
    }
  } else {
    const botInfo = await ctx.api.getMe();
    const kb = new InlineKeyboard().url(
      "Start a DM with me",
      `https://t.me/${botInfo.username}?start=help`
    );
    await ctx.reply(
      `I need to collect your bug report in a DM.\n\nTap below to start a conversation with me, then try /bugreport again.`,
      { reply_markup: kb }
    );
  }
}

// Re-export for use in index.ts auto-draw
export { updateRafflePost };
