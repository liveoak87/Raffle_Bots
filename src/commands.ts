import { InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import { parsePrizes } from "./types";
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
} from "./helpers";
import { startWizard, handleStartDeepLink, startEditWizard } from "./wizard";
import { t, getLanguageName, getAvailableLanguages } from "./i18n";
import { sendCustomImage, sendWheelSpin, sendRafflePost, getBannerFileId, sendWinnerPost } from "./banners";

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
      `/exportentries [id] - Export all participants (admin only)\n` +
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

  const raffle = db.createRaffle({
    chat_id: ctx.chat.id,
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
    keyboard
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
    await sendWheelSpin(ctx.api, ctx.chat!.id);
  }

  // Announce winners with embedded "WINNERS DRAWN" banner
  await sendWinnerPost(ctx.api, ctx.chat!.id, formatWinnersMessage(raffle, winners, lang));

  // Mark as drawn after successful announcement
  db.markRaffleDrawn(raffle.id);
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

// /exportentries - Export all participants for a raffle
export async function handleExportEntries(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can export entries.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/exportentries(@\w+)?/i, "").trim();

  if (!args) {
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

  const raffleId = parseInt(args, 10);
  if (isNaN(raffleId)) {
    await replyPrivately(ctx, "Please provide a valid raffle ID.");
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.chat_id !== ctx.chat.id) {
    await replyPrivately(ctx, "Raffle not found in this chat.");
    return;
  }

  const entries = db.getEntriesForRaffle(raffleId);

  if (entries.length === 0) {
    await replyPrivately(ctx, `No entries found for raffle "${escapeHtml(raffle.title)}".`,
      { parse_mode: "HTML" });
    return;
  }

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

  // Split if message is too long (Telegram limit is 4096)
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
      // DM failed, fall back to group with auto-delete
      await replyPrivately(ctx, `Export has ${entries.length} entries — please DM me first so I can send you the file.`);
    }
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
      newRaffle.image_file_id
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
      raffleKeyboard
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

  const raffle = db.createRaffle({
    chat_id: ctx.chat.id,
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
    keyboard
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
    await updateRafflePost(ctx, raffleId);

    // Referral link is now handled via the "Get Referral Link" button on the raffle post
    // which deep-links to the bot DM where the link is generated on demand

    // Auto-draw when max entries reached
    if (result.maxReached) {
      const raffle = db.getRaffleById(raffleId);
      if (raffle && raffle.status === "open") {
        const lang = db.getChatLanguage(raffle.chat_id);
        const entries = db.getEntriesForRaffle(raffleId);
        const entryNames = entries.map((e) => e.user_display_name);
        const winners = db.selectWinners(raffleId);

        // Countdown animation (if animation enabled)
        if (entryNames.length >= 1 && raffle.show_animation) {
          await sendWheelSpin(ctx.api, raffle.chat_id);
        }

        // Announce winners with embedded "WINNERS DRAWN" banner
        await sendWinnerPost(ctx.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang));

        db.markRaffleDrawn(raffleId);
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
    await updateRafflePost(ctx, raffleId);
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

  const entries = db.getEntriesForRaffle(raffleId);

  if (entries.length === 0) {
    await ctx.answerCallbackQuery({
      text: "No entries yet. Be the first!",
      show_alert: true,
    });
    return;
  }

  // Build entries list - Telegram popup limit is ~200 chars
  // Show most recent entries first (reverse order)
  const reversed = [...entries].reverse();

  // If referrals are enabled, show bonus entries next to names
  const showBonus = raffle && raffle.referral_enabled;
  const names = reversed.map((e, i) => {
    const num = entries.length - i;
    if (showBonus) {
      const bonus = db.getBonusEntries(raffleId, e.user_id);
      return bonus > 0
        ? `${num}. ${e.user_display_name} (+${bonus})`
        : `${num}. ${e.user_display_name}`;
    }
    return `${num}. ${e.user_display_name}`;
  });

  const totalCount = raffle && raffle.referral_enabled
    ? db.getTotalEntryCount(raffleId)
    : entries.length;
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

      try {
        // Try editMessageCaption first (for photo messages with embedded banner)
        await ctx.api.editMessageCaption(
          raffle.chat_id,
          raffle.message_id,
          { caption: formatRaffleMessage(raffle, count, lang), parse_mode: "HTML", reply_markup: keyboard }
        );
      } catch {
        // Fallback to editMessageText (for old text-only messages without banner)
        await ctx.api.editMessageText(
          raffle.chat_id,
          raffle.message_id,
          formatRaffleMessage(raffle, count, lang),
          { parse_mode: "HTML", reply_markup: keyboard }
        );
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

  let revoked = 0;
  for (const link of links) {
    try {
      await api.revokeChatInviteLink(link.chat_id, link.invite_link);
      revoked++;
    } catch {
      // Link may already be revoked, expired, or bot lost admin — skip
    }
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
  api: { sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown>; getChat: (chatId: number) => Promise<{ title?: string }> },
  raffle: { id: number; chat_id: number; title: string; creator_id: number; creator_name: string; sponsor_name: string | null },
  winners: Array<{ user_id: number; user_display_name: string; prize: string; position: number }>
): Promise<void> {
  const title = escapeHtml(raffle.title);

  // Get group title for the "won in" message
  let groupTitle = "the group";
  try {
    const chat = await api.getChat(raffle.chat_id);
    if (chat.title) groupTitle = chat.title;
  } catch {}

  // Build sponsor contact line for winner DMs
  let contactLine: string;
  if (raffle.sponsor_name) {
    const sponsor = raffle.sponsor_name.trim();
    if (sponsor.startsWith("@")) {
      const username = sponsor.replace(/^@/, "");
      contactLine = `\n\n💎 <b>Sponsor:</b> <a href="https://t.me/${escapeHtml(username)}">${escapeHtml(sponsor)}</a>\nContact them to claim your prize!`;
    } else {
      contactLine = `\n\n💎 <b>Sponsor:</b> ${escapeHtml(sponsor)}`;
    }
  } else {
    contactLine = `\n\n📍 Won in <b>${escapeHtml(groupTitle)}</b>`;
  }

  // DM each winner
  const failedDmWinners: string[] = [];
  for (const w of winners) {
    try {
      let winnerMsg = `🎉 <b>Congratulations!</b>\n\n`;
      winnerMsg += `You won in the raffle <b>${title}</b>!`;
      if (w.prize) {
        winnerMsg += `\n🎁 <b>Your prize:</b> ${escapeHtml(w.prize)}`;
      }
      winnerMsg += contactLine;
      await api.sendMessage(w.user_id, winnerMsg, { parse_mode: "HTML" });
    } catch {
      // Winner hasn't started the bot — track for group notification
      failedDmWinners.push(w.user_display_name);
    }
  }

  // Notify in group if any winners couldn't be DM'd
  if (failedDmWinners.length > 0) {
    try {
      const names = failedDmWinners.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ");
      await api.sendMessage(
        raffle.chat_id,
        `⚠️ ${names} — I couldn't send you a DM! Please start a conversation with me to receive your prize details.`,
        { parse_mode: "HTML" }
      );
    } catch {
      // Can't post in group either
    }
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
export async function buildStatsMessage(
  api: { getChat: (chatId: number) => Promise<unknown> }
): Promise<string> {
  const stats = db.getBotStats();

  // Verify which groups the bot is still active in
  const chatIds = db.getAllGroupChatIds();
  const activeGroups: { chatId: number; title: string }[] = [];
  for (const chatId of chatIds) {
    try {
      const chat = await api.getChat(chatId) as Record<string, unknown>;
      const title = chat.title ? String(chat.title) : `Chat ${chatId}`;
      activeGroups.push({ chatId, title });
    } catch {
      // Bot was removed/banned from this group — skip
    }
  }

  let msg = `📊 <b>Bot Statistics</b>\n\n`;

  msg += `<b>Usage:</b>\n`;
  msg += `  👥 Active groups: <b>${activeGroups.length}</b>\n`;
  msg += `  🧑 Unique creators: <b>${stats.totalCreators}</b>\n`;
  msg += `  🎟 Unique participants: <b>${stats.totalParticipants}</b>\n\n`;

  msg += `<b>Raffles:</b>\n`;
  msg += `  📋 Total: <b>${stats.totalRaffles}</b>\n`;
  msg += `  🟢 Active: <b>${stats.activeRaffles}</b>\n`;
  msg += `  🏆 Drawn: <b>${stats.drawnRaffles}</b>\n`;

  // Show active raffles by group
  const activeByGroup = db.getActiveRafflesByGroup();
  if (activeByGroup.length > 0) {
    msg += `\n<b>🟢 Active Raffles:</b>\n`;
    for (const group of activeByGroup) {
      const known = activeGroups.find((g) => g.chatId === group.chat_id);
      const groupTitle = known ? known.title : `Chat ${group.chat_id}`;
      msg += `  <b>${escapeHtml(groupTitle)}:</b>\n`;
      for (const raffle of group.raffles) {
        const count = db.getEntryCount(raffle.id);
        msg += `    • ${escapeHtml(raffle.title)} (${count} entries)\n`;
      }
    }
  }
  msg += `\n`;

  msg += `<b>Entries:</b>\n`;
  msg += `  📝 Total entries: <b>${stats.totalEntries}</b>\n`;
  msg += `  🏆 Total winners: <b>${stats.totalWinners}</b>\n\n`;

  msg += `<b>Last 7 days:</b>\n`;
  msg += `  📋 Raffles created: <b>${stats.rafflesLast7Days}</b>\n`;
  msg += `  📝 Entries: <b>${stats.entriesLast7Days}</b>\n`;

  if (activeGroups.length > 0) {
    msg += `\n<b>Active Groups:</b>\n`;
    for (const g of activeGroups) {
      msg += `  • ${escapeHtml(g.title)}\n`;
    }
  }

  return msg;
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

  const msg = await buildStatsMessage(ctx.api);

  // Send as DM to the owner
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
