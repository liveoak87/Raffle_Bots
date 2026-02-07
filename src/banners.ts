import path from "path";
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

/**
 * Send a branded banner image to a chat.
 * Always sends the branded banner (never overridden by custom images).
 * Returns the message_id of the sent photo, or null on failure.
 * Failures are non-fatal — the raffle still posts as text.
 */
export async function sendBanner(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      photo?: Array<{ file_id: string }>;
    }>;
  },
  chatId: number,
  bannerType: BannerType
): Promise<number | null> {
  // 1. Try cached Telegram file_id (fast, no re-upload)
  const cachedFileId = getCachedBannerFileId(bannerType);
  if (cachedFileId) {
    try {
      const msg = await api.sendPhoto(chatId, cachedFileId);
      return msg.message_id;
    } catch {
      // Cache may be stale (e.g., bot token changed) — fall through to file upload
    }
  }

  // 2. Upload from local file and cache the resulting file_id
  const filePath = getAssetPath(BANNER_FILES[bannerType]);
  try {
    const msg = await api.sendPhoto(chatId, new InputFile(filePath));
    // Cache the file_id for future sends
    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      setCachedBannerFileId(bannerType, largestPhoto.file_id);
    }
    return msg.message_id;
  } catch (err) {
    console.error(
      `Failed to send ${bannerType} banner to chat ${chatId}:`,
      err
    );
    return null;
  }
}

/**
 * Get the banner file_id as a string (for editMessageMedia).
 * Returns null if not cached and unable to upload.
 */
export async function getBannerFileId(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      photo?: Array<{ file_id: string }>;
    }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number,
  bannerType: BannerType
): Promise<string | null> {
  // Try cached file_id first
  const cachedFileId = getCachedBannerFileId(bannerType);
  if (cachedFileId) {
    return cachedFileId;
  }

  // Need to upload to get a file_id — send and delete a temporary message
  const filePath = getAssetPath(BANNER_FILES[bannerType]);
  try {
    const msg = await api.sendPhoto(chatId, new InputFile(filePath));
    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      setCachedBannerFileId(bannerType, largestPhoto.file_id);
      try {
        await api.deleteMessage(chatId, msg.message_id);
      } catch {}
      return largestPhoto.file_id;
    }
  } catch (err) {
    console.error(`Failed to get banner file_id for ${bannerType}:`, err);
  }

  return null;
}

/**
 * Get the banner file_id (cached) or InputFile for a banner type.
 * Used internally for sending raffle posts with embedded banners.
 */
export async function getBannerSource(
  api: {
    sendPhoto: (
      chatId: number,
      photo: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      photo?: Array<{ file_id: string }>;
    }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number,
  bannerType: BannerType
): Promise<string | InputFile> {
  // Try cached file_id first
  const cachedFileId = getCachedBannerFileId(bannerType);
  if (cachedFileId) {
    return cachedFileId;
  }

  // Need to upload to get a file_id — send and delete a temporary message
  const filePath = getAssetPath(BANNER_FILES[bannerType]);
  try {
    const msg = await api.sendPhoto(chatId, new InputFile(filePath));
    // Cache the file_id
    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      setCachedBannerFileId(bannerType, largestPhoto.file_id);
      // Delete the temporary message
      try {
        await api.deleteMessage(chatId, msg.message_id);
      } catch {}
      return largestPhoto.file_id;
    }
  } catch {}

  // Fallback to InputFile
  return new InputFile(filePath);
}

// Telegram photo caption limit
const MAX_CAPTION_LENGTH = 1024;

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
  customImageFileId?: string | null
): Promise<number | null> {
  try {
    // 1. Send custom image first (above the raffle) if provided
    if (customImageFileId) {
      try {
        await api.sendPhoto(chatId, customImageFileId);
      } catch (err) {
        console.error(`Failed to send custom image to chat ${chatId}:`, err);
        // Non-fatal — continue with raffle post
      }
    }

    // 2. Get the banner source (file_id or InputFile)
    const bannerSource = await getBannerSource(api, chatId, bannerType);

    // 3. Check caption length — if too long, send banner then text separately
    if (caption.length > MAX_CAPTION_LENGTH) {
      // Send banner without caption
      await api.sendPhoto(chatId, bannerSource);
      // Send text message with buttons
      const msg = await api.sendMessage(chatId, caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return msg.message_id;
    }

    // 4. Send the raffle as a photo with caption and buttons
    const msg = await api.sendPhoto(chatId, bannerSource, {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    // Cache the file_id if we uploaded a new one
    if (msg.photo && msg.photo.length > 0) {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      setCachedBannerFileId(bannerType, largestPhoto.file_id);
    }

    return msg.message_id;
  } catch (err) {
    console.error(`Failed to send raffle post to chat ${chatId}:`, err);
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
  chatId: number
): Promise<void> {
  try {
    // Send initial countdown message
    const msg = await api.sendMessage(chatId, `🎰 <b>Drawing winner in 5...</b>`, {
      parse_mode: "HTML",
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
  winnerText: string
): Promise<void> {
  const MAX_CAPTION_LENGTH = 1024;

  // Get or upload the "drawn" banner
  let fileId = getCachedBannerFileId("drawn");

  if (!fileId) {
    // Upload to get file_id
    const filePath = getAssetPath(BANNER_FILES["drawn"]);
    try {
      const msg = await api.sendPhoto(chatId, new InputFile(filePath));
      if (msg.photo && msg.photo.length > 0) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        setCachedBannerFileId("drawn", fileId);
        // Delete the temp message
        try {
          await api.deleteMessage(chatId, msg.message_id);
        } catch {}
      }
    } catch (err) {
      console.error("Failed to upload drawn banner:", err);
    }
  }

  // If we have a file_id and caption fits, send as photo with caption
  if (fileId && winnerText.length <= MAX_CAPTION_LENGTH) {
    try {
      await api.sendPhoto(chatId, fileId, {
        caption: winnerText,
        parse_mode: "HTML",
      });
      return;
    } catch (err) {
      console.error("Failed to send winner post with banner:", err);
    }
  }

  // Fallback: just send text
  try {
    await api.sendMessage(chatId, winnerText, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Failed to send winner text:", err);
  }
}
