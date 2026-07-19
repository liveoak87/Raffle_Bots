import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import type { Raffle, RaffleWinner } from "./types";
import { parsePrizes } from "./types";
import { getEntryCount, getTotalEntryCount, getChatTimezone } from "./database";
import { t } from "./i18n";
import { formatInTimezone } from "./timezone";

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

export function formatRaffleMessage(raffle: Raffle, entryCount?: number, lang: string = "en"): string {
  const baseCount = entryCount ?? getEntryCount(raffle.id);
  const maxStr = raffle.max_entries ? `/${raffle.max_entries}` : "";
  const prizes = parsePrizes(raffle);
  const hasMultiplePrizes = prizes.length > 1;

  let msg = `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n`;

  if (raffle.description) {
    msg += `${escapeHtml(raffle.description)}\n\n`;
  }

  if (hasMultiplePrizes) {
    msg += `🎁 <b>${t(lang, "raffle.prizes")}:</b>\n`;
    prizes.forEach((p, i) => {
      const label = getPositionLabel(i + 1);
      msg += `  ${label} ${escapeHtml(p)}\n`;
    });
  } else {
    msg += `🎁 <b>${t(lang, "raffle.prize")}:</b> ${escapeHtml(prizes[0])}\n`;
  }

  // Show total weighted entries (base + referral bonus) when referrals are enabled
  if (raffle.referral_enabled) {
    const totalCount = getTotalEntryCount(raffle.id);
    msg += `👥 <b>${t(lang, "raffle.entries")}:</b> ${totalCount}${maxStr} (${baseCount} participants)\n`;
  } else {
    msg += `👥 <b>${t(lang, "raffle.entries")}:</b> ${baseCount}${maxStr}\n`;
  }
  msg += `🏆 <b>${t(lang, "raffle.winners")}:</b> ${raffle.max_winners}\n`;

  // Prefer the per-raffle timezone (set by the scheduling wizard), fall back
  // to the chat's configured timezone, then UTC.
  const tz = raffle.display_timezone || getChatTimezone(raffle.chat_id);

  if (raffle.ends_at) {
    const endsDate = new Date(raffle.ends_at + "Z");
    const wall = formatInTimezone(endsDate, tz);
    msg += `⏰ <b>${t(lang, "raffle.ends")}:</b> ${formatCountdown(endsDate)} <i>(${escapeHtml(wall)})</i>\n`;
  }

  if (raffle.starts_at) {
    const startsDate = new Date(raffle.starts_at + "Z");
    if (startsDate > new Date()) {
      const wall = formatInTimezone(startsDate, tz);
      msg += `🕐 <b>${t(lang, "raffle.opens")}:</b> ${formatCountdown(startsDate).replace(" remaining", "")} <i>(${escapeHtml(wall)})</i>\n`;
    }
  }

  if (raffle.anonymous) {
    msg += `👁 ${t(lang, "raffle.hidden_entries")}\n`;
  }

  if (raffle.sponsor_name) {
    msg += `💎 <b>${t(lang, "raffle.sponsored_by")}:</b> ${escapeHtml(raffle.sponsor_name)}\n`;
  }

  // Entry requirements
  const reqs: string[] = [];
  if (raffle.require_username) reqs.push("username required");
  if (raffle.required_chat_id) {
    reqs.push(`member of ${raffle.required_chat_title || "required group"}`);
  }
  if (raffle.min_account_age_days > 0) reqs.push(`account ${raffle.min_account_age_days}d+ old`);
  if (raffle.winner_cooldown > 0) reqs.push(`recent winners excluded`);
  if (reqs.length > 0) {
    msg += `🛡 <b>Requirements:</b> ${reqs.join(" · ")}\n`;
  }

  if (raffle.referral_enabled) {
    const cap = raffle.max_referral_entries > 0
      ? `max ${raffle.max_referral_entries}`
      : "unlimited";
    msg += `🔗 <b>Referral bonus:</b> Invite friends for extra entries (${cap})\n`;
  }

  msg += `\n<i>${t(lang, "raffle.created_by")} ${escapeHtml(raffle.creator_name)}</i>`;

  if (raffle.status === "open") {
    msg += `\n\n✅ ${t(lang, "raffle.enter_cta")}`;
  } else if (raffle.status === "closed") {
    msg += `\n\n🚫 ${t(lang, "raffle.closed")}`;
  } else if (raffle.status === "drawn") {
    msg += `\n\n🎉 ${t(lang, "raffle.drawn")}`;
  }

  return msg;
}

export function formatWinnersMessage(
  raffle: Raffle,
  winners: RaffleWinner[],
  lang: string = "en"
): string {
  const prizes = parsePrizes(raffle);
  const hasMultiplePrizes = prizes.length > 1;

  let msg = `🎉 <b>${t(lang, "winner.title", { title: escapeHtml(raffle.title) })}</b>\n\n`;

  if (winners.length === 0) {
    msg += t(lang, "winner.no_entries");
  } else {
    const winnerLabel = winners.length > 1
      ? t(lang, "winner.label_plural")
      : t(lang, "winner.label");
    msg += `🏆 <b>${winnerLabel}:</b>\n`;
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
      msg += `\n🎁 <b>${t(lang, "raffle.prize")}:</b> ${escapeHtml(prizes[0])}`;
    }

    msg += `\n${t(lang, "winner.congrats_footer")} 🥳`;
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
  opts?: { parse_mode?: string; reply_markup?: unknown; link_preview_options?: { is_disabled?: boolean } }
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

  const totalSeconds = Math.floor(diffMs / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds % 60;

  // Under 1 minute: show seconds
  if (totalMinutes === 0) {
    return `${seconds}s remaining`;
  }

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

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

/**
 * Build the inline keyboard for an open raffle post.
 * Includes a "Get Referral Link" URL button when referrals are enabled.
 */
export function buildRaffleKeyboard(
  raffle: Raffle,
  displayCount: number,
  lang: string,
  botUsername: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(`🎟 ${t(lang, "btn.enter")}`, `enter_${raffle.id}`)
    .text(`❌ ${t(lang, "btn.leave")}`, `leave_${raffle.id}`)
    .row()
    .text(`👥 ${t(lang, "btn.entries", { count: displayCount })}`, `entries_${raffle.id}`);

  if (raffle.referral_enabled) {
    keyboard.url("🔗 Get Referral Link", `https://t.me/${botUsername}?start=reflink_${raffle.id}`);
  }

  keyboard.row().text("📌 Repost", `repost_${raffle.id}`);

  return keyboard;
}

export function buildMessageLink(chatId: number, messageId: number | null): string | null {
  if (!messageId) return null;
  const idStr = String(Math.abs(chatId));
  // Strip "100" prefix from supergroup IDs (stored as -100XXXXXXXXXX)
  const shortId = idStr.startsWith("100") ? idStr.slice(3) : idStr;
  return `https://t.me/c/${shortId}/${messageId}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


