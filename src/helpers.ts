import type { Context } from "grammy";
import type { Raffle, RaffleWinner } from "./types";
import { parsePrizes } from "./types";
import { getEntryCount } from "./database";

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
    msg += `⏰ <b>Ends:</b> ${endsDate.toUTCString()}\n`;
  }

  if (raffle.required_chat_title) {
    msg += `📋 <b>Requirement:</b> Must be a member of <b>${escapeHtml(raffle.required_chat_title)}</b>\n`;
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
 * Check if a user is a member of a specific chat.
 * Returns true if the user is a member, admin, creator, or restricted (but still a member).
 * Returns false if left, kicked, or not found.
 */
export async function isUserInChat(
  ctx: Context,
  chatId: number,
  userId: number
): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    return (
      member.status === "member" ||
      member.status === "administrator" ||
      member.status === "creator" ||
      member.status === "restricted"
    );
  } catch {
    return false;
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
