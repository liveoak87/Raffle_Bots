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

export function formatRaffleMessage(raffle: Raffle, entryCount?: number, lang: string = "en"): string {
  const count = entryCount ?? getEntryCount(raffle.id);
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

  msg += `👥 <b>${t(lang, "raffle.entries")}:</b> ${count}${maxStr}\n`;
  msg += `🏆 <b>${t(lang, "raffle.winners")}:</b> ${raffle.max_winners}\n`;

  if (raffle.ends_at) {
    const endsDate = new Date(raffle.ends_at + "Z");
    msg += `⏰ <b>${t(lang, "raffle.ends")}:</b> ${formatCountdown(endsDate)}\n`;
  }

  if (raffle.starts_at) {
    const startsDate = new Date(raffle.starts_at + "Z");
    if (startsDate > new Date()) {
      msg += `🕐 <b>${t(lang, "raffle.opens")}:</b> ${formatCountdown(startsDate).replace(" remaining", "")}\n`;
    }
  }

  if (raffle.anonymous) {
    msg += `👁 ${t(lang, "raffle.hidden_entries")}\n`;
  }

  if (raffle.sponsor_name) {
    msg += `💎 <b>${t(lang, "raffle.sponsored_by")}:</b> ${escapeHtml(raffle.sponsor_name)}\n`;
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a slot-machine style spin animation by editing a message,
 * showing a visible window of names scrolling and slowing down.
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

  // Build a shuffled pool of names for the scroll
  const pool = cryptoShuffleArray([...entryNames]);
  // Ensure enough names to fill the visible window on every frame
  while (pool.length < 20) {
    pool.push(...cryptoShuffleArray([...entryNames]));
  }

  // Send initial message
  const spinMsg = await api.sendMessage(
    chatId,
    `🎰 <b>${t(lang, "spin.drawing", { title: safeTitle })}</b>\n\n` +
      `🔄 ${t(lang, "spin.spinning")}`,
    { parse_mode: "HTML" }
  );
  const msgId = spinMsg.message_id;

  // Phase 1: Fast spinning (names scrolling quickly)
  // Phase 2: Slowing down (building suspense)
  // Phase 3: "And the winner is..." dramatic pause
  const frames: { delay: number; offset: number; phase: "fast" | "slow" | "reveal" }[] = [];

  // Fast phase: 5 frames
  for (let i = 0; i < 5; i++) {
    frames.push({ delay: 400, offset: i * 3, phase: "fast" });
  }
  // Slow phase: 5 frames, progressively slower
  const slowDelays = [600, 800, 1000, 1300, 1800];
  for (let i = 0; i < slowDelays.length; i++) {
    frames.push({ delay: slowDelays[i], offset: 15 + i * 2, phase: "slow" });
  }
  // Final reveal frame
  frames.push({ delay: 2000, offset: pool.length - 3, phase: "reveal" });

  for (const frame of frames) {
    await sleep(frame.delay);

    // Build the visible "slot window" — 5 names with the middle one highlighted
    const windowSize = 5;
    const windowNames: string[] = [];
    for (let j = 0; j < windowSize; j++) {
      const idx = (frame.offset + j) % pool.length;
      windowNames.push(pool[idx]);
    }

    const middleIdx = Math.floor(windowSize / 2);
    let slotDisplay = "";

    if (frame.phase === "reveal") {
      // Final frame: dramatic reveal
      slotDisplay += `\n✨ ${t(lang, "spin.winner_is")} ✨\n\n`;
      slotDisplay += `     <i>${escapeHtml(windowNames[middleIdx - 1])}</i>\n`;
      slotDisplay += `▸ 🎯 <b>${escapeHtml(windowNames[middleIdx])}</b> 🎯 ◂\n`;
      slotDisplay += `     <i>${escapeHtml(windowNames[middleIdx + 1])}</i>`;
    } else {
      // Scrolling frames: show the slot window
      for (let j = 0; j < windowSize; j++) {
        const name = escapeHtml(windowNames[j]);
        if (j === middleIdx) {
          // Highlighted center row
          slotDisplay += `▸ <b>${name}</b> ◂\n`;
        } else {
          // Faded surrounding rows
          const dist = Math.abs(j - middleIdx);
          if (dist === 1) {
            slotDisplay += `   <i>${name}</i>\n`;
          } else {
            slotDisplay += `      ${name}\n`;
          }
        }
      }
    }

    // Speed indicator
    let speedLabel = "";
    if (frame.phase === "fast") {
      speedLabel = "⚡ " + t(lang, "spin.spinning");
    } else if (frame.phase === "slow") {
      speedLabel = "🔄 " + t(lang, "spin.spinning");
    }

    let text = `🎰 <b>${t(lang, "spin.drawing", { title: safeTitle })}</b>\n\n`;
    text += `┌─────────────────┐\n`;
    text += slotDisplay;
    text += `└─────────────────┘`;
    if (speedLabel) {
      text += `\n\n${speedLabel}`;
    }

    try {
      await api.editMessageText(chatId, msgId, text, { parse_mode: "HTML" });
    } catch {
      // Edit failed (rate limit or deleted), skip frame
    }
  }

  return msgId;
}

/** Simple crypto-random shuffle for the spin animation pool */
function cryptoShuffleArray<T>(arr: T[]): T[] {
  const crypto = require("crypto");
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const bytes = crypto.randomBytes(4);
    const j = bytes.readUInt32BE(0) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
