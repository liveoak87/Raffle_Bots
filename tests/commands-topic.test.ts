import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

describe("set raffle topic command", () => {
  let db: typeof import("../src/database");
  let commands: typeof import("../src/commands");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    commands = await import("../src/commands");
  });

  function topicCommand(createdName: string): Context {
    return {
      from: { id: 99, first_name: "Admin", is_bot: false },
      chat: { id: -1001, type: "supergroup", title: "Test Group", is_forum: true },
      message: {
        message_id: 200,
        message_thread_id: 163,
        date: 1,
        text: "/setraffletopic",
        chat: { id: -1001, type: "supergroup", title: "Test Group", is_forum: true },
        reply_to_message: {
          message_id: 163,
          date: 1,
          chat: { id: -1001, type: "supergroup", title: "Test Group", is_forum: true },
          forum_topic_created: { name: createdName, icon_color: 0x6fb9f0 },
        },
      },
      api: {
        getChatMember: vi.fn().mockResolvedValue({ status: "creator" }),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      },
      reply: vi.fn().mockResolvedValue({}),
    } as unknown as Context;
  }

  it("saves the topic name attached to a standalone slash command", async () => {
    await commands.handleSetRaffleTopic(topicCommand("Raffles"));

    expect(db.getGroupDefaults(-1001)).toMatchObject({
      thread_id: 163,
      thread_name: "Raffles",
    });
    expect(db.getForumTopicName(-1001, 163)).toBe("Raffles");
  });

  it("prefers a cached rename over the original creation name", async () => {
    db.rememberForumTopicName(-1001, 163, "Weekly Raffles");

    await commands.handleSetRaffleTopic(topicCommand("Raffles"));

    expect(db.getGroupDefaults(-1001)).toMatchObject({
      thread_id: 163,
      thread_name: "Weekly Raffles",
    });
  });

  it("does not replace an already-saved current name with stale cache data", async () => {
    db.rememberForumTopicName(-1001, 163, "Original Name");
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Current Name" });

    await commands.handleSetRaffleTopic(topicCommand("Original Name"));

    expect(db.getGroupDefaults(-1001)).toMatchObject({
      thread_id: 163,
      thread_name: "Current Name",
    });
    expect(db.getForumTopicName(-1001, 163)).toBe("Current Name");
  });
});
