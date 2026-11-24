import type { Api } from "grammy";
import { logger } from "./logger";

/** Only messages explicitly sent by a raffle setup belong in this collection. */
export class RaffleSetupMessages {
  private readonly messageIds = new Set<number>();
  private closed = false;
  private cleanupTask: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: Pick<Api, "deleteMessages" | "deleteMessage" | "editMessageReplyMarkup">,
    private readonly chatId: number
  ) {}

  async track(message: { message_id: number; chat: { id: number } }): Promise<void> {
    // Never delete the group raffle post, menus, or messages from another chat.
    if (message.chat.id !== this.chatId || this.chatId <= 0) return;
    this.messageIds.add(message.message_id);
    // A send may finish after this draft expired or was replaced.
    if (this.closed) await this.cleanup();
  }

  cleanup(): Promise<void> {
    this.closed = true;
    // Serialize repeated cleanup requests, including late-arriving messages.
    this.cleanupTask = this.cleanupTask.then(async () => {
      const ids = [...this.messageIds];
      this.messageIds.clear();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        try {
          // Telegram skips messages that have already been deleted.
          await this.api.deleteMessages(this.chatId, batch);
        } catch {
          // One old/undeletable message must not prevent the rest being removed.
          for (const messageId of batch) {
            try {
              await this.api.deleteMessage(this.chatId, messageId);
            } catch (err) {
              const description = String((err as { description?: string })?.description ?? "");
              if (description.includes("message to delete not found")) continue;
              try {
                await this.api.editMessageReplyMarkup(this.chatId, messageId, {
                  reply_markup: { inline_keyboard: [] },
                });
              } catch {
                // Deletion and editing can both fail when a message is gone.
              }
              logger.warn(
                { chat_id: this.chatId, message_id: messageId },
                "Could not delete raffle setup message; attempted to remove its buttons"
              );
            }
          }
        }
      }
    });
    return this.cleanupTask;
  }
}
