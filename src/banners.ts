import path from "path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Api } from "grammy";
import { InputFile, InlineKeyboard } from "grammy";
import { getCachedBannerFileId, setCachedBannerFileId } from "./database";

export type BannerType = "open" | "drawn" | "closed";

const BANNER_FILES: Record<BannerType, string> = {
  open: "banner_open.png",
  drawn: "banner_drawn.png",
  closed: "banner_closed.png",
};

function getAssetPath(filename: string): string {
  return path.join(process.cwd(), "assets", filename);
}

// Telegram file IDs belong to one bot. Version each entry by asset contents so
// a restart reuses the ID and replacing a banner uploads the new artwork.
const assetHashes = new Map<BannerType, string>();

async function withBanner<T extends true | { message_id: number; photo?: Array<{ file_id: string }> }>(
  type: BannerType, post: (source: string | InputFile) => Promise<T>
): Promise<T> {
  const file = getAssetPath(BANNER_FILES[type]);
  let hash = assetHashes.get(type);
  if (!hash) {
    hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    assetHashes.set(type, hash);
  }
  const botId = process.env.BOT_TOKEN?.split(":")[0] ?? "offline";
  const key = `${botId}:${type}:${hash}`;
  const cached = getCachedBannerFileId(key);
  if (cached) {
    try {
      return await post(cached);
    } catch (error) {
      const err = error as { error_code?: number; description?: string };
      if (err?.error_code !== 400 || !/wrong (?:remote )?file identifier|file_id_invalid|file_reference_expired/i.test(err.description ?? "")) throw error;
    }
  }
  const message = await post(new InputFile(file));
  const fileId = message !== true && message.photo?.at(-1)?.file_id;
  if (fileId) {
    try {
      setCachedBannerFileId(key, fileId);
    } catch (error) {
      console.error("Could not cache accepted Telegram banner", error);
    }
  }
  return message;
}

export async function editClosedBanner(api: Pick<Api, "editMessageMedia">, chatId: number, messageId: number, caption: string) {
  await withBanner("closed", media => api.editMessageMedia(chatId, messageId, {
    type: "photo", media, caption, parse_mode: "HTML",
  }));
}

// Telegram photo caption limit
const MAX_CAPTION_LENGTH = 1024;
const MAX_MESSAGE_LENGTH = 3900;

/** Split only at line boundaries so generated HTML entities/tags stay intact. */
function splitWinnerText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > MAX_MESSAGE_LENGTH) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Detect Telegram errors that indicate the target forum topic is closed.
 * When this happens, we should retry posting to the chat's General topic
 * (i.e. without message_thread_id) so winners still get announced publicly.
 */
function isTopicClosedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { error_code?: number; description?: string };
  return (
    e.error_code === 400 &&
    typeof e.description === "string" &&
    e.description.includes("TOPIC_CLOSED")
  );
}

/**
 * Send a complete raffle post with the banner embedded as the photo.
 * Custom image (if any) is sent FIRST (above the raffle).
 * If caption exceeds 1024 chars, falls back to sending banner + separate text message.
 * Returns the message_id of the raffle post, or null on failure.
 */
export async function sendRafflePost(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      photo?: Array<{ file_id: string }>;
    }>;
    sendMessage: (
      chatId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number,
  bannerType: BannerType,
  caption: string,
  keyboard: InlineKeyboard,
  customImageFileId?: string | null,
  threadId?: number | null
): Promise<number | null> {
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  const sentMessageIds: number[] = [];
  try {
    // 1. Send custom image first (above the raffle) if provided
    if (customImageFileId) {
      try {
        const customImage = await api.sendPhoto(chatId, customImageFileId, threadOpts);
        sentMessageIds.push(customImage.message_id);
      } catch (err) {
        console.error(`Failed to send custom image to chat ${chatId}:`, err);
        // Non-fatal — continue with raffle post
      }
    }

    if (caption.length > MAX_CAPTION_LENGTH) {
      const banner = await withBanner(bannerType, source => api.sendPhoto(chatId, source, threadOpts));
      sentMessageIds.push(banner.message_id);
      const msg = await api.sendMessage(chatId, caption, {
        parse_mode: "HTML", reply_markup: keyboard, ...threadOpts,
      });
      return msg.message_id;
    }

    const msg = await withBanner(bannerType, source => api.sendPhoto(chatId, source, {
      caption, parse_mode: "HTML", reply_markup: keyboard, ...threadOpts,
    }));
    return msg.message_id;
  } catch (err) {
    console.error(`Failed to send raffle post to chat ${chatId}:`, err);
    // Roll back any custom image or split banner already posted so callers
    // can safely delete the unposted raffle row without leaving orphan media.
    for (const messageId of sentMessageIds.reverse()) {
      try {
        await api.deleteMessage(chatId, messageId);
      } catch {}
    }
    return null;
  }
}

/**
 * Send a custom raffle image below the raffle post.
 * Non-fatal — if it fails, the raffle is still fine.
 */
export async function sendCustomImage(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
  },
  chatId: number,
  imageFileId: string
): Promise<number | null> {
  try {
    const msg = await api.sendPhoto(chatId, imageFileId);
    return msg.message_id;
  } catch (err) {
    console.error(`Failed to send custom image to chat ${chatId}:`, err);
    return null;
  }
}

/**
 * Send a 5-second countdown before revealing winners.
 * Non-fatal — if anything fails, the draw still proceeds.
 */
export async function sendWheelSpin(
  api: {
    sendMessage: (
      chatId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
    editMessageText: (
      chatId: number,
      messageId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number,
  threadId?: number | null
): Promise<void> {
  const threadOpts = threadId ? { message_thread_id: threadId } : {};
  try {
    // Send initial countdown message
    const msg = await api.sendMessage(chatId, `🎰 <b>Drawing winner in 5...</b>`, {
      parse_mode: "HTML",
      ...threadOpts,
    });

    // Countdown from 4 to 1
    for (let i = 4; i >= 1; i--) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        await api.editMessageText(
          chatId,
          msg.message_id,
          `🎰 <b>Drawing winner in ${i}...</b>`,
          { parse_mode: "HTML" }
        );
      } catch {
        // Edit failed, continue anyway
      }
    }

    // Brief pause then delete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await api.deleteMessage(chatId, msg.message_id);
    } catch {
      // Delete failed (permissions) — leave it, not critical
    }
  } catch (err) {
    if (isTopicClosedError(err) && threadId) {
      // Topic was closed before draw — skip countdown silently;
      // sendWinnerPost will fall back to the General topic.
      return;
    }
    console.error(`Failed to send countdown to chat ${chatId}:`, err);
    // Non-fatal — the draw proceeds without the animation
  }
}

/**
 * Send the winner announcement as a photo with the "drawn" banner and winner details as caption.
 */
export async function sendWinnerPost(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      photo?: Array<{ file_id: string }>;
    }>;
    sendMessage: (
      chatId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number,
  winnerText: string,
  threadId?: number | null
): Promise<void> {
  let activeThread = threadId;
  async function inTopic(send: (options: { message_thread_id?: number }) => Promise<unknown>) {
    try {
      await send(activeThread ? { message_thread_id: activeThread } : {});
    } catch (error) {
      if (!activeThread || !isTopicClosedError(error)) throw error;
      activeThread = null;
      await send({});
    }
  }

  if (winnerText.length <= MAX_CAPTION_LENGTH) {
    try {
      await inTopic(opts => withBanner("drawn", source => api.sendPhoto(chatId, source, {
        caption: winnerText, parse_mode: "HTML", ...opts,
      })));
      return;
    } catch (error) {
      console.error("Failed to send winner banner, using text", error);
    }
  }

  for (const chunk of splitWinnerText(winnerText)) {
    await inTopic(opts => api.sendMessage(chatId, chunk, { parse_mode: "HTML", ...opts }));
  }
}
