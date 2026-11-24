import type { Api } from "grammy";
import * as db from "./database";
import { buildRaffleKeyboard, formatRaffleMessage } from "./helpers";
import { isUnchangedEdit } from "./telegramTransport";

interface RenderedPost {
  messageId: number;
  key: string;
  isPhoto: boolean;
}
const rendered = new Map<number, RenderedPost>();
const editing = new Map<number, Promise<void>>();

export function pruneRenderedPosts(activeIds: Set<number>) {
  for (const id of rendered.keys()) {
    if (!activeIds.has(id)) rendered.delete(id);
  }
}

export async function finishOpenPostEdits(raffleId: number) {
  await editing.get(raffleId);
  rendered.delete(raffleId);
}

export async function refreshOpenRafflePost(api: Api, raffleId: number, username: string) {
  const previous = editing.get(raffleId);
  const edit = (previous ?? Promise.resolve()).then(async () => {
    // Re-read after earlier edits so an entry burst or a draw cannot queue
    // an obsolete count or keyboard for a later send.
    const raffle = db.getRaffleById(raffleId);
    if (!raffle?.message_id || raffle.status !== "open") return;
    const { chat_id: chatId, message_id: messageId } = raffle;
    const count = db.getEntryCount(raffleId);
    const total = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;
    const lang = db.getChatLanguage(raffle.chat_id);
    const keyboard = buildRaffleKeyboard(raffle, total, lang, username);
    const text = formatRaffleMessage(raffle, count, lang);
    const key = JSON.stringify([text, keyboard.inline_keyboard]);
    const last = rendered.get(raffleId);
    const sameMessage = last?.messageId === raffle.message_id;
    if (sameMessage && last.key === key) return;
    const options = { parse_mode: "HTML", reply_markup: keyboard } as const;
    if (!sameMessage || last.isPhoto) {
      try {
        await api.editMessageCaption(chatId, messageId, { caption: text, ...options });
      } catch (error) {
        if (!isUnchangedEdit(error)) {
          // Only an unknown message type needs a second API call.
          if (sameMessage) throw error;
          const err = error as { error_code?: number };
          if (err?.error_code !== 400) throw error;
          await editText();
          return;
        }
      }
      rendered.set(raffleId, { messageId, key, isPhoto: true });
    } else {
      await editText();
    }

    async function editText() {
      try {
        await api.editMessageText(chatId, messageId, text, options);
      } catch (error) {
        if (!isUnchangedEdit(error)) throw error;
      }
      rendered.set(raffleId, { messageId, key, isPhoto: false });
    }
  }).catch(() => {
    // A lost response can represent an accepted edit. Reconcile on the next refresh.
    rendered.delete(raffleId);
  });
  editing.set(raffleId, edit);
  try {
    await edit;
  } finally {
    if (editing.get(raffleId) === edit) editing.delete(raffleId);
  }
}
