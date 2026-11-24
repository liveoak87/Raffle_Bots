import { describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { hasGroupKeeperAdministrator } from "../src/groupkeeper";

function apiWithAdministrators(administrators: unknown[]): Api {
  return {
    raw: {
      getChatAdministrators: vi.fn().mockResolvedValue(administrators),
    },
  } as unknown as Api;
}

describe("GroupKeeper referral routing", () => {
  it("requests bot administrators and detects GroupKeeper case-insensitively", async () => {
    const api = apiWithAdministrators([
      {
        status: "administrator",
        user: { is_bot: true, username: "TheGroupKeeperBot" },
      },
    ]);

    await expect(hasGroupKeeperAdministrator(api, -1001)).resolves.toBe(true);
    expect(api.raw.getChatAdministrators).toHaveBeenCalledWith({
      chat_id: -1001,
      return_bots: true,
    });
  });

  it("does not route through similarly named bots or human administrators", async () => {
    const api = apiWithAdministrators([
      {
        status: "administrator",
        user: { is_bot: true, username: "FakeGroupKeeperBot" },
      },
      {
        status: "creator",
        user: { is_bot: false, username: "TheGroupKeeperBot" },
      },
    ]);

    await expect(hasGroupKeeperAdministrator(api, -1001)).resolves.toBe(false);
  });
});
