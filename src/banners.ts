import path from "path";
import { InputFile } from "grammy";
import { getCachedBannerFileId, setCachedBannerFileId } from "./database";

export type BannerType = "open" | "drawn" | "closed";

const BANNER_FILES: Record<BannerType, string> = {
  open: "banner_open.png",
  drawn: "banner_drawn.png",
  closed: "banner_closed.png",
};

const WHEEL_GIF = "wheel_spin.gif";
const WHEEL_CACHE_KEY = "wheel_spin";
const WHEEL_PLAY_TIME = 5000; // ms to let the GIF play before deleting

function getAssetPath(filename: string): string {
  return path.join(process.cwd(), "assets", filename);
}

/**
 * Send a branded banner image to a chat.
 *
 * Priority: customImageFileId > cached file_id > local file upload.
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
  bannerType: BannerType,
  customImageFileId?: string | null
): Promise<number | null> {
  // 1. Custom per-raffle image takes priority
  if (customImageFileId) {
    try {
      const msg = await api.sendPhoto(chatId, customImageFileId);
      return msg.message_id;
    } catch {
      // Custom image failed — fall through to default banner
    }
  }

  // 2. Try cached Telegram file_id (fast, no re-upload)
  const cachedFileId = getCachedBannerFileId(bannerType);
  if (cachedFileId) {
    try {
      const msg = await api.sendPhoto(chatId, cachedFileId);
      return msg.message_id;
    } catch {
      // Cache may be stale (e.g., bot token changed) — fall through to file upload
    }
  }

  // 3. Upload from local file and cache the resulting file_id
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
 * Send the spinning wheel GIF animation, wait for it to play,
 * then delete it. Used before revealing winners.
 * Non-fatal — if anything fails, the draw still proceeds.
 */
export async function sendWheelSpin(
  api: {
    sendAnimation: (
      chatId: number,
      animation: string | InputFile,
      opts?: Record<string, unknown>
    ) => Promise<{
      message_id: number;
      animation?: { file_id: string };
    }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<unknown>;
  },
  chatId: number
): Promise<void> {
  let msgId: number | null = null;

  try {
    // 1. Try cached file_id
    const cachedFileId = getCachedBannerFileId(WHEEL_CACHE_KEY);
    if (cachedFileId) {
      try {
        const msg = await api.sendAnimation(chatId, cachedFileId);
        msgId = msg.message_id;
      } catch {
        // Cache stale — fall through to file upload
      }
    }

    // 2. Upload from local file
    if (!msgId) {
      const filePath = getAssetPath(WHEEL_GIF);
      const msg = await api.sendAnimation(chatId, new InputFile(filePath));
      msgId = msg.message_id;
      // Cache the file_id
      if (msg.animation?.file_id) {
        setCachedBannerFileId(WHEEL_CACHE_KEY, msg.animation.file_id);
      }
    }

    // 3. Wait for the animation to play
    await new Promise((resolve) => setTimeout(resolve, WHEEL_PLAY_TIME));

    // 4. Delete the GIF message
    if (msgId) {
      try {
        await api.deleteMessage(chatId, msgId);
      } catch {
        // Delete failed (permissions) — leave it, not critical
      }
    }
  } catch (err) {
    console.error(`Failed to send wheel spin GIF to chat ${chatId}:`, err);
    // Non-fatal — the draw proceeds without the animation
  }
}
