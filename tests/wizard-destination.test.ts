import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

describe("raffle wizard destinations", () => {
  let db: typeof import("../src/database");
  let wizard: typeof import("../src/wizard");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    wizard = await import("../src/wizard");
  });

  function privateContext(userId = 99): { ctx: Context; reply: ReturnType<typeof vi.fn> } {
    const reply = vi.fn().mockResolvedValue({});
    const ctx = {
      from: { id: userId, first_name: "Admin", is_bot: false },
      chat: { id: userId, type: "private", first_name: "Admin" },
      api: {
        getChatMember: vi.fn().mockResolvedValue({ status: "creator" }),
      },
      reply,
    } as unknown as Context;
    return { ctx, reply };
  }

  it("starts Command Central raffles in the saved named topic", async () => {
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Raffles" });
    const { ctx, reply } = privateContext();

    await wizard.startRaffleWizardForGroup(ctx, -1001, "Test Group");

    expect(wizard.getActiveWizard(99)).toMatchObject({
      targetThreadId: 163,
      targetThreadName: "Raffles",
    });
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Destination: <b>Raffles (group default)</b>"),
      expect.any(Object)
    );
  });

  it("keeps an explicit topic override and displays its cached name", async () => {
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Raffles" });
    db.rememberForumTopicName(-1001, 222, "Flash Raffles");
    const { ctx, reply } = privateContext();

    await wizard.startRaffleWizardForGroup(ctx, -1001, "Test Group", 222);

    expect(wizard.getActiveWizard(99)).toMatchObject({
      targetThreadId: 222,
      targetThreadName: "Flash Raffles",
    });
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Destination: <b>Flash Raffles</b>"),
      expect.any(Object)
    );
  });

  it("allows an explicit General override despite a saved topic", async () => {
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Raffles" });
    const { ctx } = privateContext();

    await wizard.startRaffleWizardForGroup(ctx, -1001, "Test Group", null);

    expect(wizard.getActiveWizard(99)).toMatchObject({
      targetThreadId: null,
      targetThreadName: null,
    });
  });
});
