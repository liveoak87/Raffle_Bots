import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import { parsePrizes } from "./types";
import {
  escapeHtml,
  getUserDisplayName,
  formatRaffleMessage,
  formatWinnersMessage,
  isGroupAdmin,
  isUserInChat,
  parseEndTime,
} from "./helpers";
import { startWizard, handleStartDeepLink } from "./wizard";

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
      `/draw - Draw winners for a raffle\n` +
      `/cancelraffle - Cancel a raffle\n` +
      `/myentries - See your active entries\n` +
      `/rafflehistory - View past raffles\n` +
      `/exportentries - Export participant list\n` +
      `/rerun - Re-run a raffle with same participants\n` +
      `/help - Show this help message\n\n` +
      `Add me to a group to get started!`,
    { parse_mode: "HTML" }
  );
}

// /help
export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `🎟 <b>Raffle Bot Help</b>\n\n` +
      `<b>Creating a Raffle:</b>\n` +
      `/newraffle - Show creation help\n\n` +
      `<b>Quick format:</b>\n` +
      `<code>/newraffle Title | Prize</code>\n\n` +
      `<b>With options:</b>\n` +
      `<code>/newraffle Title | Prize | winners:N | max:N | ends:30m</code>\n\n` +
      `<b>Multiple prizes (one per winner position):</b>\n` +
      `<code>/newraffle Title | prizes: $100, $50, $25 | ends:1d</code>\n\n` +
      `<b>Require group membership:</b>\n` +
      `<code>/newraffle Title | Prize | require:-1001234567890 GroupName</code>\n\n` +
      `<b>Parameters:</b>\n` +
      `• <b>Title</b> - Name of the raffle (required)\n` +
      `• <b>Prize</b> - Single prize (or use prizes: for multiple)\n` +
      `• <b>prizes: A, B, C</b> - Comma-separated prizes for 1st, 2nd, 3rd...\n` +
      `• <b>winners:N</b> - Number of winners (default: 1, auto-set from prizes count)\n` +
      `• <b>max:N</b> - Maximum entries (optional)\n` +
      `• <b>ends:TIME</b> - Auto-close time (30m, 2h, 1d)\n` +
      `• <b>require:CHAT_ID GroupName</b> - Require membership in another group\n\n` +
      `<b>Time formats:</b> 30m, 2h, 1d, or YYYY-MM-DD HH:MM\n\n` +
      `<b>Management:</b>\n` +
      `/draw [id] - Draw winners (admin only)\n` +
      `/cancelraffle [id] - Cancel a raffle (admin only)\n` +
      `/exportentries [id] - Export all participants (admin only)\n` +
      `/rerun [id] - Re-run a past raffle with same participants (admin only)\n` +
      `/raffles - List open raffles in this chat\n` +
      `/rafflehistory - View recent raffle history\n` +
      `/myentries - See your active entries\n\n` +
      `<b>Note:</b> Only group admins can create raffles and draw winners.`,
    { parse_mode: "HTML" }
  );
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
    await ctx.reply("Only group admins can create raffles.");
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
    await ctx.reply("Title is required.");
    return;
  }

  let singlePrize = "";
  let prizesList: string[] | null = null;
  let maxWinners = 1;
  let maxEntries: number | null = null;
  let endsAt: string | null = null;
  let description = "";
  let requiredChatId: number | null = null;
  let requiredChatTitle: string | null = null;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const partLower = part.toLowerCase();

    const winnersMatch = partLower.match(/^winners?\s*:\s*(\d+)$/);
    const maxMatch = partLower.match(/^max\s*:\s*(\d+)$/);
    const endsMatch = part.match(/^ends?\s*:\s*(.+)$/i);
    const prizesMatch = part.match(/^prizes?\s*:\s*(.+)$/i);
    const requireMatch = part.match(/^require\s*:\s*(-?\d+)\s+(.+)$/i);

    if (winnersMatch) {
      maxWinners = Math.max(1, Math.min(50, parseInt(winnersMatch[1], 10)));
    } else if (maxMatch) {
      maxEntries = Math.max(1, parseInt(maxMatch[1], 10));
    } else if (endsMatch) {
      const parsed = parseEndTime(endsMatch[1].trim());
      if (parsed) {
        endsAt = parsed.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      } else {
        await ctx.reply(
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
        await ctx.reply("Please provide at least one prize.");
        return;
      }
    } else if (requireMatch) {
      requiredChatId = parseInt(requireMatch[1], 10);
      requiredChatTitle = requireMatch[2].trim();
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
    await ctx.reply(
      "Please provide a prize.\n" +
        "Example: <code>/newraffle Title | Prize</code>\n" +
        "Or: <code>/newraffle Title | prizes: $100, $50, $25</code>",
      { parse_mode: "HTML" }
    );
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
    required_chat_id: requiredChatId,
    required_chat_title: requiredChatTitle,
  });

  const keyboard = new InlineKeyboard()
    .text("🎟 Enter Raffle", `enter_${raffle.id}`)
    .text("❌ Leave", `leave_${raffle.id}`)
    .row()
    .text(`👥 Entries (0)`, `entries_${raffle.id}`);

  const msg = await ctx.reply(formatRaffleMessage(raffle, 0), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });

  db.updateRaffleMessageId(raffle.id, msg.message_id);
}

// /raffles - List open raffles
export async function handleListRaffles(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const raffles = db.getOpenRafflesForChat(ctx.chat.id);

  if (raffles.length === 0) {
    await ctx.reply(
      "No open raffles in this chat. Use /newraffle to create one!"
    );
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
    if (raffle.required_chat_title) {
      msg += `   📋 Requires: ${escapeHtml(raffle.required_chat_title)}\n`;
    }
    if (raffle.ends_at) {
      msg += `   ⏰ Ends: ${new Date(raffle.ends_at + "Z").toUTCString()}\n`;
    }
    msg += `\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
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
    await ctx.reply("Only group admins can draw raffle winners.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/draw(@\w+)?/i, "").trim();

  let raffle: ReturnType<typeof db.getRaffleById>;

  if (args) {
    const raffleId = parseInt(args, 10);
    if (isNaN(raffleId)) {
      await ctx.reply("Please provide a valid raffle ID. Usage: /draw 1");
      return;
    }
    raffle = db.getRaffleById(raffleId);
  } else {
    const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);
    if (openRaffles.length === 0) {
      await ctx.reply("No open raffles to draw from.");
      return;
    }
    if (openRaffles.length === 1) {
      raffle = openRaffles[0];
    } else {
      let msg = `Multiple open raffles found. Please specify which one:\n\n`;
      for (const r of openRaffles) {
        msg += `/draw ${r.id} - ${escapeHtml(r.title)}\n`;
      }
      await ctx.reply(msg, { parse_mode: "HTML" });
      return;
    }
  }

  if (!raffle) {
    await ctx.reply("Raffle not found.");
    return;
  }

  if (raffle.chat_id !== ctx.chat.id) {
    await ctx.reply("That raffle doesn't belong to this chat.");
    return;
  }

  if (raffle.status === "drawn") {
    await ctx.reply("This raffle has already been drawn.");
    return;
  }

  const entryCount = db.getEntryCount(raffle.id);
  if (entryCount === 0) {
    db.markRaffleDrawn(raffle.id);
    await ctx.reply(
      `🎟 <b>${escapeHtml(raffle.title)}</b>\n\nNo entries were received. Raffle closed with no winners.`,
      { parse_mode: "HTML" }
    );
    await updateRafflePost(ctx, raffle.id);
    return;
  }

  const winners = db.selectWinners(raffle.id);

  await ctx.reply(formatWinnersMessage(raffle, winners), {
    parse_mode: "HTML",
  });

  await updateRafflePost(ctx, raffle.id);
}

// /cancelraffle - Cancel a raffle
export async function handleCancelRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await ctx.reply("Only group admins can cancel raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/cancelraffle(@\w+)?/i, "").trim();

  if (!args) {
    const openRaffles = db.getOpenRafflesForChat(ctx.chat.id);
    if (openRaffles.length === 0) {
      await ctx.reply("No open raffles to cancel.");
      return;
    }
    let msg = `Which raffle do you want to cancel?\n\n`;
    for (const r of openRaffles) {
      msg += `/cancelraffle ${r.id} - ${escapeHtml(r.title)}\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const raffleId = parseInt(args, 10);
  if (isNaN(raffleId)) {
    await ctx.reply("Please provide a valid raffle ID.");
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.chat_id !== ctx.chat.id) {
    await ctx.reply("Raffle not found in this chat.");
    return;
  }

  if (raffle.status === "drawn") {
    await ctx.reply("Cannot cancel a raffle that has already been drawn.");
    return;
  }

  db.closeRaffle(raffleId);

  await ctx.reply(
    `🚫 Raffle <b>${escapeHtml(raffle.title)}</b> has been cancelled.`,
    { parse_mode: "HTML" }
  );

  await updateRafflePost(ctx, raffleId);
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
    await ctx.reply("You haven't entered any active raffles in this chat.");
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
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
}

// /rafflehistory - Show recent raffles
export async function handleRaffleHistory(ctx: Context): Promise<void> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("Use this command in a group chat.");
    return;
  }

  const raffles = db.getRecentRafflesForChat(ctx.chat.id, 10);

  if (raffles.length === 0) {
    await ctx.reply("No raffle history in this chat.");
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

  await ctx.reply(msg, { parse_mode: "HTML" });
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
    await ctx.reply("Only group admins can export entries.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/exportentries(@\w+)?/i, "").trim();

  if (!args) {
    const allRaffles = db.getRecentRafflesForChat(ctx.chat.id, 20);
    if (allRaffles.length === 0) {
      await ctx.reply("No raffles found in this chat.");
      return;
    }
    let msg = `Which raffle do you want to export?\n\n`;
    for (const r of allRaffles) {
      const count = db.getEntryCount(r.id);
      msg += `/exportentries ${r.id} - ${escapeHtml(r.title)} (${count} entries, ${r.status})\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const raffleId = parseInt(args, 10);
  if (isNaN(raffleId)) {
    await ctx.reply("Please provide a valid raffle ID.");
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.chat_id !== ctx.chat.id) {
    await ctx.reply("Raffle not found in this chat.");
    return;
  }

  const entries = db.getEntriesForRaffle(raffleId);

  if (entries.length === 0) {
    await ctx.reply(`No entries found for raffle "${escapeHtml(raffle.title)}".`, {
      parse_mode: "HTML",
    });
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
    // Send participant list as a document
    const csvLines = ["#,Display Name,Username,User ID,Entered At"];
    entries.forEach((e, i) => {
      csvLines.push(
        `${i + 1},"${e.user_display_name}","${e.user_name || ""}",${e.user_id},"${e.entered_at}"`
      );
    });

    const buffer = Buffer.from(csvLines.join("\n"), "utf-8");
    await ctx.replyWithDocument(
      new InputFile(buffer, `raffle_${raffle.id}_participants.csv`),
      {
        caption: `📋 Participants for "${raffle.title}" (${entries.length} entries)\n\nUse /rerun ${raffle.id} to create a new raffle with these same participants.`,
      }
    );
  } else {
    await ctx.reply(msg, { parse_mode: "HTML" });
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
    await ctx.reply("Only group admins can re-run raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/rerun(@\w+)?/i, "").trim();

  if (!args) {
    const drawnRaffles = db
      .getRecentRafflesForChat(ctx.chat.id, 20)
      .filter((r) => r.status === "drawn" || r.status === "closed");
    if (drawnRaffles.length === 0) {
      await ctx.reply("No completed raffles to re-run.");
      return;
    }
    let msg = `Which raffle do you want to re-run?\n\n`;
    for (const r of drawnRaffles) {
      const count = db.getEntryCount(r.id);
      msg += `/rerun ${r.id} - ${escapeHtml(r.title)} (${count} entries)\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }

  const sourceId = parseInt(args, 10);
  if (isNaN(sourceId)) {
    await ctx.reply("Please provide a valid raffle ID.");
    return;
  }

  const sourceRaffle = db.getRaffleById(sourceId);
  if (!sourceRaffle || sourceRaffle.chat_id !== ctx.chat.id) {
    await ctx.reply("Raffle not found in this chat.");
    return;
  }

  const sourceEntries = db.getEntriesForRaffle(sourceId);
  if (sourceEntries.length === 0) {
    await ctx.reply("The source raffle has no entries to copy.");
    return;
  }

  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  // Create a new raffle with the same settings
  const newRaffle = db.createRaffle({
    chat_id: ctx.chat.id,
    creator_id: userId,
    creator_name: displayName,
    title: `${sourceRaffle.title} (Re-run)`,
    description: sourceRaffle.description,
    prize: sourceRaffle.prize,
    prizes: sourceRaffle.prizes,
    max_entries: null, // Don't limit since we're pre-filling
    max_winners: sourceRaffle.max_winners,
    ends_at: null,
    required_chat_id: sourceRaffle.required_chat_id,
    required_chat_title: sourceRaffle.required_chat_title,
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

  const keyboard = new InlineKeyboard()
    .text("🎟 Enter Raffle", `enter_${newRaffle.id}`)
    .text("❌ Leave", `leave_${newRaffle.id}`)
    .row()
    .text(`👥 Entries (${added})`, `entries_${newRaffle.id}`);

  const msg = await ctx.reply(
    formatRaffleMessage(newRaffle, added) +
      `\n\n🔄 <i>Re-run of raffle #${sourceId} with ${added} participants copied.</i>`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );

  db.updateRaffleMessageId(newRaffle.id, msg.message_id);
}

// --- Callback query handlers ---

export async function handleEnterCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("enter_", ""), 10);
  if (isNaN(raffleId)) return;

  const userId = ctx.from!.id;

  // Check required group membership
  const raffle = db.getRaffleById(raffleId);
  if (raffle && raffle.required_chat_id) {
    const isMember = await isUserInChat(ctx, raffle.required_chat_id, userId);
    if (!isMember) {
      const groupName = raffle.required_chat_title || "the required group";
      await ctx.answerCallbackQuery({
        text: `You must be a member of ${groupName} to enter this raffle.`,
        show_alert: true,
      });
      return;
    }
  }

  const userName = ctx.from!.username || "";
  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  const result = db.addEntry(raffleId, userId, userName, displayName);

  if (result.success) {
    await ctx.answerCallbackQuery({ text: "🎟 You're in! Good luck!" });
    await updateRafflePost(ctx, raffleId);
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

  if (removed) {
    await ctx.answerCallbackQuery({ text: "You've left the raffle." });
    await updateRafflePost(ctx, raffleId);
  } else {
    await ctx.answerCallbackQuery({
      text: "You weren't in this raffle.",
      show_alert: true,
    });
  }
}

export async function handleEntriesCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("entries_", ""), 10);
  if (isNaN(raffleId)) return;

  const entries = db.getEntriesForRaffle(raffleId);

  if (entries.length === 0) {
    await ctx.answerCallbackQuery({
      text: "No entries yet. Be the first!",
      show_alert: true,
    });
    return;
  }

  const names = entries
    .map((e, i) => `${i + 1}. ${e.user_display_name}`)
    .join("\n");

  await ctx.answerCallbackQuery({
    text: `Entries (${entries.length}):\n${names}`.slice(0, 200),
    show_alert: true,
  });
}

// --- Utility ---

async function updateRafflePost(ctx: Context, raffleId: number): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || !raffle.message_id) return;

  const count = db.getEntryCount(raffleId);

  try {
    if (raffle.status === "open") {
      const keyboard = new InlineKeyboard()
        .text("🎟 Enter Raffle", `enter_${raffle.id}`)
        .text("❌ Leave", `leave_${raffle.id}`)
        .row()
        .text(`👥 Entries (${count})`, `entries_${raffle.id}`);

      await ctx.api.editMessageText(
        raffle.chat_id,
        raffle.message_id,
        formatRaffleMessage(raffle, count),
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } else {
      // Raffle is closed or drawn - remove entry buttons
      let text = formatRaffleMessage(raffle, count);

      if (raffle.status === "drawn") {
        const winners = db.getWinnersForRaffle(raffleId);
        if (winners.length > 0) {
          text += `\n\n🏆 <b>Winners:</b>\n`;
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

      await ctx.api.editMessageText(
        raffle.chat_id,
        raffle.message_id,
        text,
        { parse_mode: "HTML" }
      );
    }
  } catch {
    // Message may have been deleted or too old to edit
  }
}

// Re-export for use in index.ts auto-draw
export { updateRafflePost };

// InputFile import for document sending
import { InputFile } from "grammy";
