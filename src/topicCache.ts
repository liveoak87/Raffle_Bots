import * as db from "./database";
import {
  getAuthoritativeForumTopicName,
  getForumTopicId,
  getForumTopicName,
  type ForumTopicMessage,
} from "./forumTopics";

/** Learn topic names without letting icon-only activity replace a newer name. */
export function rememberForumTopicFromMessage(
  chatId: number,
  message?: ForumTopicMessage
): void {
  const authoritativeTopicName = getAuthoritativeForumTopicName(message);
  const topicName = authoritativeTopicName || getForumTopicName(message);
  const topicId = getForumTopicId(message);
  const hasAuthoritativeTopicName = Boolean(authoritativeTopicName);
  if (!topicName || !topicId) return;

  const defaults = db.getGroupDefaults(chatId);
  if (!hasAuthoritativeTopicName && defaults?.thread_id === topicId && defaults.thread_name) {
    db.rememberForumTopicName(chatId, topicId, defaults.thread_name, false);
  }
  db.rememberForumTopicName(chatId, topicId, topicName, hasAuthoritativeTopicName);

  const resolvedName = db.getForumTopicName(chatId, topicId);
  if (
    hasAuthoritativeTopicName &&
    resolvedName &&
    defaults?.thread_id === topicId &&
    defaults.thread_name !== resolvedName
  ) {
    db.upsertGroupDefaults(chatId, { thread_name: resolvedName });
  }
}
