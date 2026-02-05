import type { Context } from "grammy";
import type { Raffle, RaffleWinner } from "./types";
import { parsePrizes } from "./types";
import { getEntryCount } from "./database";
import { t } from "./i18n";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getUserDisplayName(
  firstName: string,
  lastName?: string
): string {
  return lastName ? `${firstName} ${lastName}` : firstName;
}

export function formatRaffleMessage(raffle: Raffle, entryCount?: number): string {
  const count = entryCount ?? getEntryCount(raffle.id);
  const maxStr = raffle.max_entries ? `/${raffle.max_entries}` : "";
  const prizes = parsePrizes(raffle);
  const hasMultiplePrizes = prizes.length > 1;

  let msg = `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n`;

  if (raffle.description) {
    msg += `${escapeHtml(raffle.description)}\n\n`;
  }

  if (hasMultiplePrizes) {
    msg += `🎁 <b>Prizes:</b>\n`;
    prizes.forEach((p, i) => {
      const label = getPositionLabel(i + 1);
      msg += `  ${label} ${escapeHtml(p)}\n`;
    });
  } else {
    msg += `🎁 <b>Prize:</b> ${escapeHtml(prizes[0])}\n`;
  }

  msg += `👥 <b>Entries:</b> ${count}${maxStr}\n`;
  msg += `🏆 <b>Winners:</b> ${raffle.max_winners}\n`;

  if (raffle.ends_at) {
    const endsDate = new Date(raffle.ends_at + "Z");
    msg += `⏰ <b>Ends:</b> ${formatCountdown(endsDate)}\n`;
  }

  if (raffle.starts_at) {
    const startsDate = new Date(raffle.starts_at + "Z");
    if (startsDate > new Date()) {
      msg += `🕐 <b>Opens:</b> ${formatCountdown(startsDate).replace(" remaining", "")}\n`;
    }
  }

  if (raffle.anonymous) {
    msg += `👁 <b>Entries:</b> Hidden until draw\n`;
  }

  if (raffle.sponsor_name) {
    msg += `💎 <b>Sponsored by:</b> ${escapeHtml(raffle.sponsor_name)}\n`;
  }

  msg += `\n<i>Created by ${escapeHtml(raffle.creator_name)}</i>`;

  if (raffle.status === "open") {
    msg += `\n\n✅ Tap the button below to enter!`;
  } else if (raffle.status === "closed") {
    msg += `\n\n🚫 This raffle is closed.`;
  } else if (raffle.status === "drawn") {
    msg += `\n\n🎉 Winners have been drawn!`;
  }

  return msg;
}

export function formatWinnersMessage(
  raffle: Raffle,
  winners: RaffleWinner[]
): string {
  const prizes = parsePrizes(raffle);
  const hasMultiplePrizes = prizes.length > 1;

  let msg = `🎉 <b>Raffle Drawn: ${escapeHtml(raffle.title)}</b>\n\n`;

  if (winners.length === 0) {
    msg += `No entries were received. No winners selected.`;
  } else {
    msg += `🏆 <b>Winner${winners.length > 1 ? "s" : ""}:</b>\n`;
    winners.forEach((w, i) => {
      const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
      if (hasMultiplePrizes) {
        const label = getPositionLabel(i + 1);
        msg += `  ${label} ${mention}\n`;
        msg += `      🎁 ${escapeHtml(w.prize)}\n`;
      } else {
        msg += `  ${i + 1}. ${mention}\n`;
      }
    });

    if (!hasMultiplePrizes) {
      msg += `\n🎁 <b>Prize:</b> ${escapeHtml(prizes[0])}`;
    }

    msg += `\nCongratulations! 🥳`;
  }

  return msg;
}

export async function isGroupAdmin(
  ctx: Context,
  userId: number
): Promise<boolean> {
  try {
    const chatMember = await ctx.api.getChatMember(ctx.chat!.id, userId);
    return (
      chatMember.status === "administrator" ||
      chatMember.status === "creator"
    );
  } catch {
    return false;
  }
}

/**
 * Send a message privately to the user via DM.
 * Falls back to a temporary group message that auto-deletes after 8 seconds.
 */
export async function replyPrivately(
  ctx: Context,
  text: string,
  opts?: { parse_mode?: string; reply_markup?: unknown }
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    await ctx.api.sendMessage(userId, text, opts as Record<string, unknown>);
  } catch {
    // DM failed — send temporary message in group
    try {
      const msg = await ctx.reply(text, opts as Record<string, unknown>);
      const chatId = ctx.chat!.id;
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(chatId, msg.message_id);
        } catch {}
      }, 8000);
    } catch {}
  }
}

export function parseEndTime(input: string): Date | null {
  const now = new Date();

  // Try relative time: "30m", "2h", "1d"
  const relativeMatch = input.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();

    if (unit.startsWith("m")) {
      return new Date(now.getTime() + amount * 60 * 1000);
    } else if (unit.startsWith("h")) {
      return new Date(now.getTime() + amount * 60 * 60 * 1000);
    } else if (unit.startsWith("d")) {
      return new Date(now.getTime() + amount * 24 * 60 * 60 * 1000);
    }
  }

  // Try absolute datetime
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime()) && parsed > now) {
    return parsed;
  }

  return null;
}

export function formatCountdown(target: Date): string {
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();

  if (diffMs <= 0) {
    return "Ended";
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  if (parts.length === 0) return "< 1 minute";

  return parts.join(" ") + " remaining";
}

function getPositionLabel(position: number): string {
  switch (position) {
    case 1:
      return "🥇";
    case 2:
      return "🥈";
    case 3:
      return "🥉";
    default:
      return `${position}.`;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a wheel spin animation by rapidly editing a message,
 * cycling through entry names and slowing down to reveal winners.
 * Returns the message ID of the spin message (for further editing).
 */
export async function performWheelSpin(
  api: {
    sendMessage: (
      chatId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<{ message_id: number; chat: { id: number } }>;
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
  },
  chatId: number,
  entryNames: string[],
  raffleTitle: string,
  lang: string = "en"
): Promise<number> {
  const safeTitle = escapeHtml(raffleTitle);

  // Send initial spinning message
  const spinMsg = await api.sendMessage(
    chatId,
    `🎰 <b>${t(lang, "spin.drawing", { title: safeTitle })}</b>\n\n` +
      `🔄 ${t(lang, "spin.spinning")}`,
    { parse_mode: "HTML" }
  );

  const msgId = spinMsg.message_id;

  // Timing: start fast, slow down for suspense
  const delays = [500, 500, 500, 600, 700, 800, 1000, 1200, 1500, 2000];

  for (let i = 0; i < delays.length; i++) {
    await sleep(delays[i]);

    // Pick a random name to display
    const idx = Math.floor(Math.random() * entryNames.length);
    const displayName = entryNames[idx];

    // Visual progress bar
    const filled = i + 1;
    const empty = delays.length - filled;
    const progress = "\u2593".repeat(filled) + "\u2591".repeat(empty);

    try {
      await api.editMessageText(
        chatId,
        msgId,
        `🎰 <b>${t(lang, "spin.drawing", { title: safeTitle })}</b>\n\n` +
          `${progress}\n\n` +
          `🎯 <b>${escapeHtml(displayName)}</b>`,
        { parse_mode: "HTML" }
      );
    } catch {
      // Edit failed (rate limit or deleted), skip frame
    }
  }

  return msgId;
}
