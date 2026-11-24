import { describe, expect, it, vi } from "vitest";
import { RaffleSetupMessages } from "../src/raffleSetupMessages";

function api() {
  return {
    deleteMessages: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
  };
}

describe("raffle setup message cleanup", () => {
  it("deletes only tracked private messages, deduplicated in batches of 100", async () => {
    const transport = api();
    const messages = new RaffleSetupMessages(transport, 123);
    for (let id = 1; id <= 205; id++) {
      await messages.track({ message_id: id, chat: { id: 123 } });
    }
    await messages.track({ message_id: 1, chat: { id: 123 } });
    await messages.track({ message_id: 300, chat: { id: -1001 } });
    await messages.track({ message_id: 301, chat: { id: 456 } });

    await messages.cleanup();
    await messages.cleanup();

    expect(transport.deleteMessages.mock.calls.map(([, ids]) => ids.length)).toEqual([100, 100, 5]);
    expect(transport.deleteMessages.mock.calls.flatMap(([, ids]) => ids)).toEqual(
      Array.from({ length: 205 }, (_, i) => i + 1)
    );
    expect(transport.deleteMessages.mock.calls.every(([chatId]) => chatId === 123)).toBe(true);
  });

  it("handles a late send after the draft's cleanup has completed", async () => {
    const transport = api();
    const messages = new RaffleSetupMessages(transport, 123);
    await messages.cleanup();
    await messages.track({ message_id: 10, chat: { id: 123 } });
    expect(transport.deleteMessages).toHaveBeenCalledWith(123, [10]);
  });

  it("falls back per message and removes buttons if deletion is unavailable", async () => {
    const transport = api();
    transport.deleteMessages.mockRejectedValue(new Error("batch failed"));
    transport.deleteMessage
      .mockRejectedValueOnce({ description: "Bad Request: message to delete not found" })
      .mockRejectedValueOnce(new Error("too old"))
      .mockResolvedValueOnce(true);
    const messages = new RaffleSetupMessages(transport, 123);
    for (const id of [1, 2, 3]) await messages.track({ message_id: id, chat: { id: 123 } });

    await expect(messages.cleanup()).resolves.toBeUndefined();

    expect(transport.deleteMessage).toHaveBeenCalledTimes(3);
    expect(transport.editMessageReplyMarkup).toHaveBeenCalledExactlyOnceWith(123, 2, {
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("contains deletion and fallback errors so creation can still succeed", async () => {
    const transport = api();
    transport.deleteMessages.mockRejectedValue(new Error("offline"));
    transport.deleteMessage.mockRejectedValue(new Error("offline"));
    transport.editMessageReplyMarkup.mockRejectedValue(new Error("offline"));
    const messages = new RaffleSetupMessages(transport, 123);
    await messages.track({ message_id: 10, chat: { id: 123 } });
    await expect(messages.cleanup()).resolves.toBeUndefined();
  });
});
