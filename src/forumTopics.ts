interface ForumTopicMessage {
  message_thread_id?: number;
  message_id: number;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name?: string };
  reply_to_message?: {
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
  };
}

function cleanTopicName(name: string | undefined): string | null {
  const cleaned = name?.trim();
  return cleaned ? cleaned : null;
}

/**
 * Telegram attaches the topic-creation service message as reply_to_message
 * when a message is sent normally inside a forum topic. That nested service
 * message contains the human-readable topic name.
 */
export function getForumTopicName(message?: ForumTopicMessage): string | null {
  return (
    cleanTopicName(message?.forum_topic_edited?.name) ||
    cleanTopicName(message?.forum_topic_created?.name) ||
    cleanTopicName(message?.reply_to_message?.forum_topic_edited?.name) ||
    cleanTopicName(message?.reply_to_message?.forum_topic_created?.name)
  );
}

/** Topic-create service messages use their own message ID as the topic ID. */
export function getForumTopicId(message?: ForumTopicMessage): number | null {
  return message?.message_thread_id ?? (message?.forum_topic_created ? message.message_id : null);
}

/** Explicit template destinations win; otherwise templates follow the group default. */
export function resolveTemplateThreadId(
  templateThreadId: number | null | undefined,
  defaultThreadId: number | null | undefined
): number | null {
  return templateThreadId ?? defaultThreadId ?? null;
}
