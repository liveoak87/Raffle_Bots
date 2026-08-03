import { beforeEach, describe, expect, it, vi } from "vitest";

describe("forum topic name cache", () => {
  let db: typeof import("../src/database");
  let topicCache: typeof import("../src/topicCache");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    topicCache = await import("../src/topicCache");
  });

  it("does not revert a saved name when only the topic icon changes", () => {
    db.rememberForumTopicName(-1001, 163, "Weekly Raffles");
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Weekly Raffles" });

    topicCache.rememberForumTopicFromMessage(-1001, {
      message_id: 300,
      message_thread_id: 163,
      forum_topic_edited: { icon_custom_emoji_id: "emoji-id" },
      reply_to_message: {
        forum_topic_created: { name: "Original Name" },
      },
    });

    expect(db.getForumTopicName(-1001, 163)).toBe("Weekly Raffles");
    expect(db.getGroupDefaults(-1001)?.thread_name).toBe("Weekly Raffles");
  });

  it("updates both the cache and saved default when the name changes", () => {
    db.rememberForumTopicName(-1001, 163, "Raffles");
    db.upsertGroupDefaults(-1001, { thread_id: 163, thread_name: "Raffles" });

    topicCache.rememberForumTopicFromMessage(-1001, {
      message_id: 301,
      message_thread_id: 163,
      forum_topic_edited: { name: "Weekly Raffles" },
    });

    expect(db.getForumTopicName(-1001, 163)).toBe("Weekly Raffles");
    expect(db.getGroupDefaults(-1001)?.thread_name).toBe("Weekly Raffles");
  });
});
