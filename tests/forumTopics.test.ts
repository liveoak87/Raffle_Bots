import { describe, expect, it } from "vitest";
import { getForumTopicId, getForumTopicName } from "../src/forumTopics";

describe("forum topic detection", () => {
  it("reads the topic name attached to a normal command message", () => {
    expect(
      getForumTopicName({
        message_id: 200,
        message_thread_id: 163,
        reply_to_message: {
          forum_topic_created: { name: "Raffles" },
        },
      })
    ).toBe("Raffles");
  });

  it("reads renamed topics from service messages", () => {
    expect(
      getForumTopicName({
        message_id: 201,
        message_thread_id: 163,
        forum_topic_edited: { name: "Weekly Raffles" },
      })
    ).toBe("Weekly Raffles");
  });

  it("uses a topic-create service message ID when no thread ID is present", () => {
    expect(
      getForumTopicId({
        message_id: 163,
        forum_topic_created: { name: "Raffles" },
      })
    ).toBe(163);
  });

  it("does not invent a name for an explicit reply to an ordinary message", () => {
    expect(
      getForumTopicName({
        message_id: 202,
        message_thread_id: 163,
        reply_to_message: {},
      })
    ).toBeNull();
  });
});
