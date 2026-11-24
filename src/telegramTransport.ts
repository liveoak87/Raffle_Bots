import { autoRetry } from "@grammyjs/auto-retry";
import type { Transformer } from "grammy";

// Longer than Telegram's 30-second long poll, without the default 500s stall.
export const TELEGRAM_API_TIMEOUT_SECONDS = 60;
export const POLLING_OPTIONS = {
  retryInterval: 5_000,
  maxRetryTime: 5 * 60_000,
} as const;

/** Retry explicit rate limits. Network failures belong to the runner/job queue. */
export function telegramRetry(): Transformer {
  const retry = autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 90,
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: true,
  });
  return (prev, method, payload, signal) =>
    method === "getUpdates"
      ? prev(method, payload, signal)
      : retry(prev, method, payload, signal);
}

/** Only a successful poll proves that the incoming update path is working. */
export function createTelegramHealth(now: () => number = Date.now) {
  let mode: "starting" | "polling" | "webhook" | "stopped" = "starting";
  let lastPoll: number | undefined;
  return {
    polling() { mode = "polling"; },
    webhook() { mode = "webhook"; },
    stopped() { mode = "stopped"; },
    pollSucceeded() { lastPoll = now(); },
    isHealthy() {
      return mode === "webhook" ||
        (mode === "polling" && lastPoll !== undefined && now() - lastPoll < 120_000);
    },
  };
}

/** Telegram confirms identical edits with a 400 response. */
export function isUnchangedEdit(error: unknown): boolean {
  const err = error as { error_code?: number; description?: string } | null;
  return err?.error_code === 400 && /message is not modified/i.test(err.description ?? "");
}

const GROUP_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendAnimation", "sendVideo", "sendDocument", "sendSticker",
  "sendChatAction", "editMessageText", "editMessageCaption", "editMessageReplyMarkup",
  "editMessageMedia", "deleteMessage", "pinChatMessage", "unpinChatMessage", "sendDice", "sendPoll",
]);

export function createGroupThrottle() {
  interface Group {
    lastRequest?: number;
    messages: number[];
    tail: Promise<void>;
    queued: number;
  }
  const groups = new Map<number, Group>();
  const transform: Transformer = async (prev, method, payload, signal) => {
    const chatId = (payload as { chat_id?: unknown }).chat_id;
    if (typeof chatId === "number" && chatId < 0 && GROUP_METHODS.has(method)) {
      let group = groups.get(chatId);
      if (!group) {
        group = { messages: [], tail: Promise.resolve(), queued: 0 };
        groups.set(chatId, group);
      }
      const state = group;
      state.queued++;
      const sendsMessage = method.startsWith("send") && method !== "sendChatAction";
      const slot = state.tail.then(async () => {
        const now = Date.now();
        state.messages = state.messages.filter(time => now - time < 60_000);
        const nextRequest = state.lastRequest === undefined ? now : state.lastRequest + 1_100;
        const nextMessage = sendsMessage && state.messages.length >= 20 ? state.messages[0] + 60_000 : now;
        const delay = Math.max(nextRequest, nextMessage) - now;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (signal?.aborted) return;
        state.lastRequest = Date.now();
        if (sendsMessage) state.messages.push(state.lastRequest);
      });
      state.tail = slot;
      try {
        await slot;
      } finally {
        state.queued--;
      }
    }
    return prev(method, payload, signal);
  };
  function prune() {
    for (const [id, group] of groups) {
      if (!group.queued && Date.now() - (group.lastRequest ?? 0) >= 60_000) groups.delete(id);
    }
  }
  return { transform, prune };
}
