import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/database", () => ({
  getCachedBannerFileId: vi.fn(() => "cached-drawn-banner"),
  setCachedBannerFileId: vi.fn(),
}));

import { InputFile } from "grammy";
import { getCachedBannerFileId, setCachedBannerFileId } from "../src/database";
import { editClosedBanner, sendRafflePost, sendWinnerPost } from "../src/banners";

describe("sendWinnerPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves only after Telegram accepts an announcement", async () => {
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendMessage: vi.fn(),
      deleteMessage: vi.fn(),
    };

    await expect(sendWinnerPost(api, -1001, "Winner!")).resolves.toBeUndefined();
    expect(api.sendPhoto).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects when both photo and text delivery fail", async () => {
    const finalError = Object.assign(new Error("chat unavailable"), { error_code: 500 });
    const api = {
      sendPhoto: vi.fn().mockRejectedValue(new Error("photo failed")),
      sendMessage: vi.fn().mockRejectedValue(finalError),
      deleteMessage: vi.fn(),
    };

    await expect(sendWinnerPost(api, -1001, "Winner!")).rejects.toBe(finalError);
  });

  it("falls back to text when a caption is too long", async () => {
    const api = {
      sendPhoto: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
      deleteMessage: vi.fn(),
    };

    await expect(sendWinnerPost(api, -1001, "x".repeat(1025))).resolves.toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("splits oversized winner text only at safe line boundaries", async () => {
    const api = {
      sendPhoto: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
      deleteMessage: vi.fn(),
    };
    const line = '<a href="tg://user?id=1">Winner</a>';
    const text = Array.from({ length: 150 }, () => line).join("\n");

    await sendWinnerPost(api, -1001, text);
    expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of api.sendMessage.mock.calls) {
      expect(call[1]).not.toMatch(/<a[^>]*>[^<]*$/);
    }
  });
});

describe("sendRafflePost", () => {
  it("removes a custom image if the raffle post itself fails", async () => {
    const api = {
      sendPhoto: vi.fn()
        .mockResolvedValueOnce({ message_id: 10 })
        .mockRejectedValueOnce(new Error("raffle banner failed")),
      sendMessage: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      sendRafflePost(api, -1001, "open", "caption", {} as never, "custom-image")
    ).resolves.toBeNull();
    expect(api.deleteMessage).toHaveBeenCalledWith(-1001, 10);
  });
});

describe("banner delivery", () => {
  it("uploads the first real post and reuses its Telegram file ID on the next post", async () => {
    const cache = new Map<string, string>();
    vi.mocked(getCachedBannerFileId).mockImplementation(key => cache.get(key) ?? null);
    vi.mocked(setCachedBannerFileId).mockImplementation((key, id) => { cache.set(key, id); });
    const api = {
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 1, photo: [{ file_id: "uploaded" }] }),
      sendMessage: vi.fn(), deleteMessage: vi.fn(),
    };
    await sendRafflePost(api, -100, "open", "caption", {} as never, null, 42);
    await sendRafflePost(api, -100, "open", "caption", {} as never, null, 42);
    expect(api.sendPhoto.mock.calls.map(call => call[1])).toEqual([expect.any(InputFile), "uploaded"]);
    expect(api.sendPhoto.mock.calls[0][2]).toMatchObject({ caption: "caption", message_thread_id: 42 });
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });

  it("replaces a rejected cached ID by uploading in the media edit", async () => {
    vi.mocked(getCachedBannerFileId).mockReturnValue("stale");
    const editMessageMedia = vi.fn()
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: wrong file identifier" })
      .mockResolvedValue({ message_id: 1, photo: [{ file_id: "new-id" }] });
    await editClosedBanner({ editMessageMedia }, -100, 1, "Closed");
    expect(editMessageMedia.mock.calls.map(call => call[2].media)).toEqual(["stale", expect.any(InputFile)]);
    expect(setCachedBannerFileId).toHaveBeenCalledWith(expect.stringContaining(":closed:"), "new-id");
  });

  it("retries a cold winner photo in General if its topic was closed", async () => {
    vi.mocked(getCachedBannerFileId).mockReturnValue(null);
    const api = {
      sendPhoto: vi.fn().mockRejectedValueOnce({ error_code: 400, description: "TOPIC_CLOSED" })
        .mockResolvedValueOnce({ message_id: 2 }),
      sendMessage: vi.fn(), deleteMessage: vi.fn(),
    };
    await sendWinnerPost(api, -100, "Winner", 42);
    expect(api.sendPhoto.mock.calls.map(call => call[2])).toEqual([
      { caption: "Winner", parse_mode: "HTML", message_thread_id: 42 },
      { caption: "Winner", parse_mode: "HTML" },
    ]);
    expect(api.deleteMessage).not.toHaveBeenCalled();
  });
});
