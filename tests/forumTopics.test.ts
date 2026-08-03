import { describe, expect, it } from "vitest";
import {
  getAuthoritativeForumTopicName,
  getForumTopicId,
  getForumTopicName,
  resolveTemplateThreadId,
} from "../src/forumTopics";

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

  it("does not treat an icon-only edit as a topic-name change", () => {
    const message = {
      message_id: 202,
      message_thread_id: 163,
      forum_topic_edited: { icon_custom_emoji_id: "emoji-id" },
      reply_to_message: {
        forum_topic_created: { name: "Original Name" },
      },
    };

    expect(getAuthoritativeForumTopicName(message)).toBeNull();
    expect(getForumTopicName(message)).toBe("Original Name");
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

  it("uses an explicit template destination before the group default", () => {
    expect(resolveTemplateThreadId(200, 163)).toBe(200);
    expect(resolveTemplateThreadId(null, 163)).toBe(163);
    expect(resolveTemplateThreadId(null, null)).toBeNull();
  });
});
