import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import {
  escapeHtml,
  getUserDisplayName,
  formatRaffleMessage,
  formatWinnersMessage,
  isGroupAdmin,
  parseEndTime,
} from "./helpers";

// /start - Welcome message (works in private chat)
export async function handleStart(ctx: Context): Promise<void> {
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
      `/newraffle - Start the raffle creation wizard\n\n` +
      `Or use the quick format:\n` +
      `<code>/newraffle Title | Prize | winners:N | max:N | ends:30m</code>\n\n` +
      `<b>Parameters:</b>\n` +
      `• <b>Title</b> - Name of the raffle (required)\n` +
      `• <b>Prize</b> - What the winner gets (required)\n` +
      `• <b>winners:N</b> - Number of winners (default: 1)\n` +
      `• <b>max:N</b> - Maximum entries (optional)\n` +
      `• <b>ends:TIME</b> - Auto-close time (e.g., 30m, 2h, 1d)\n\n` +
      `<b>Time formats:</b> 30m, 2h, 1d, or YYYY-MM-DD HH:MM\n\n` +
      `<b>Management:</b>\n` +
      `/draw [id] - Draw winners (admin only)\n` +
      `/cancelraffle [id] - Cancel a raffle (admin only)\n` +
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
    await ctx.reply(
      `📝 <b>Create a Raffle</b>\n\n` +
        `Use this format:\n` +
        `<code>/newraffle Title | Prize</code>\n\n` +
        `Or with options:\n` +
        `<code>/newraffle Title | Prize | winners:3 | max:100 | ends:2h</code>\n\n` +
        `<b>Options:</b>\n` +
        `• <b>winners:N</b> - Number of winners (default: 1)\n` +
        `• <b>max:N</b> - Max entries allowed\n` +
        `• <b>ends:TIME</b> - Auto-close (30m, 2h, 1d, etc.)`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const parts = args.split("|").map((p) => p.trim());
  if (parts.length < 2) {
    await ctx.reply(
      "Please provide at least a title and prize separated by |.\n" +
        "Example: <code>/newraffle Epic Giveaway | $50 Gift Card</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const title = parts[0];
  const prize = parts[1];
  let maxWinners = 1;
  let maxEntries: number | null = null;
  let endsAt: string | null = null;
  let description = "";

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i].toLowerCase();
    const winnersMatch = part.match(/^winners?\s*:\s*(\d+)$/);
    const maxMatch = part.match(/^max\s*:\s*(\d+)$/);
    const endsMatch = parts[i].match(/^ends?\s*:\s*(.+)$/i);

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
    } else {
      description += (description ? "\n" : "") + parts[i];
    }
  }

  if (!title || !prize) {
    await ctx.reply("Title and prize are required.");
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
    prize,
    max_entries: maxEntries,
    max_winners: maxWinners,
    ends_at: endsAt,
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
    msg += `<b>${raffle.id}.</b> ${escapeHtml(raffle.title)}\n`;
    msg += `   🎁 ${escapeHtml(raffle.prize)} | 👥 ${count}${maxStr} entries\n`;
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
    msg += `• ${escapeHtml(r.title)} (ID: ${r.id})\n`;
    msg += `  🎁 ${escapeHtml(r.prize)}\n`;
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

    msg += `${statusEmoji} <b>${escapeHtml(raffle.title)}</b>\n`;
    msg += `   🎁 ${escapeHtml(raffle.prize)} | 👥 ${count} entries | ${raffle.status}\n`;

    if (raffle.status === "drawn") {
      const winners = db.getWinnersForRaffle(raffle.id);
      if (winners.length > 0) {
        msg += `   🏆 ${winners.map((w) => escapeHtml(w.user_display_name)).join(", ")}\n`;
      }
    }
    msg += `\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
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

  const result = db.addEntry(raffleId, userId, userName, displayName);

  if (result.success) {
    await ctx.answerCallbackQuery({ text: "🎟 You're in! Good luck!" });
    await updateRafflePost(ctx, raffleId);
  } else {
    await ctx.answerCallbackQuery({ text: result.reason || "Could not enter.", show_alert: true });
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
          winners.forEach((w, i) => {
            text += `  ${i + 1}. <a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>\n`;
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
