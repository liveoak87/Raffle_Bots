import { Bot } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import * as wizard from "../src/wizard";
import * as commands from "../src/commands";
import * as db from "../src/database";
import { filterAndCleanRaffleCommands } from "../src/commandRegistry";
import { getWorkflow, workflowMiddleware, workflowUpdateKeys } from "../src/workflowSessions";

export const GROUP = -1004491315719;
export const USER = 8723884396;
export type Call = { method: string; payload: Record<string, any>; messageId?: number };
export function workflowHarness() {
  const calls: Call[] = [];
  let id = 100;
  const settings = {
    fail: undefined as ((method: string, payload: Record<string, any>) => boolean) | undefined,
    delay: undefined as ((method: string, payload: Record<string, any>) => Promise<void>) | undefined,
    memberStatus: "creator",
    blockCommands: false,
    interceptMessage: false,
  };
  const info = { id: 1234, is_bot: true as const, first_name: "Test", username: "WorkflowTestBot" };
  const bot = new Bot("1234:offline-tests", { botInfo: info });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, any>;
    const call: Call = { method, payload: JSON.parse(JSON.stringify(p)) };
    calls.push(call);
    await settings.delay?.(method, p);
    if (settings.fail?.(method, p)) return { ok: false, error_code: 400, description: "Bad Request: test delivery failure" };
    if (method === "getChatMember") return { ok: true, result: { status: settings.memberStatus, user: { id: p.user_id, is_bot: false, first_name: "Test" } } };
    if (method === "getChat") return { ok: true, result: { id: p.chat_id, type: "supergroup", title: "Test Group" } };
    if (method === "getMe") return { ok: true, result: info };
    if (method === "sendMessage" || method === "sendPhoto" || method === "editMessageText") {
      call.messageId = method === "editMessageText" ? p.message_id : ++id;
      return { ok: true, result: { message_id: call.messageId, date: 1, text: p.text, chat: { id: p.chat_id, type: p.chat_id > 0 ? "private" : "supergroup" }, reply_markup: p.reply_markup, photo: [{ file_id: "test-photo" }] } };
    }
    if (["answerCallbackQuery", "deleteMessage", "deleteMessages", "editMessageReplyMarkup", "editMessageCaption", "editMessageMedia", "pinChatMessage", "unpinChatMessage", "revokeChatInviteLink"].includes(method)) return { ok: true, result: true };
    throw new Error(`Unexpected Telegram method: ${method}`);
  });
  bot.use(sequentialize(workflowUpdateKeys));
  bot.use(filterAndCleanRaffleCommands);
  bot.use(workflowMiddleware);
  bot.use(async (ctx, next) => { if (settings.blockCommands && ctx.message?.text?.startsWith("/")) return; await next(); });
  bot.command("start", commands.handleStart);
  bot.command("newraffle", commands.handleNewRaffle);
  bot.command("setraffletopic", commands.handleSetRaffleTopic);
  bot.command("manage", commands.handleManage);
  bot.command("bugreport", commands.handleBugReport);
  bot.callbackQuery(/^admin_/, commands.handleAdminCallback);
  bot.callbackQuery(/^home_/, commands.handleHomeCallback);
  bot.callbackQuery(/^edit_/, wizard.handleEditCallback);
  bot.callbackQuery(/^wiz_winners_\d+$/, wizard.handleWinnersCallback);
  bot.callbackQuery("wiz_winners_custom", wizard.handleWinnersCustomCallback);
  bot.callbackQuery(/^wiz_time_/, wizard.handleTimeCallback);
  bot.callbackQuery(/^wiz_opt_/, wizard.handleOptionsCallback);
  bot.callbackQuery(/^wiz_sched_/, wizard.handleSchedPickerCallback);
  bot.callbackQuery(/^wsc:/, wizard.handleCalendarPickerCallback);
  bot.callbackQuery(/^wotz:/, wizard.handleStandaloneTzCallback);
  bot.callbackQuery(/^twiz_winners_\d+$/, wizard.handleTmplWinnersCallback);
  bot.callbackQuery("twiz_winners_custom", wizard.handleTmplWinnersCustomCallback);
  bot.callbackQuery(/^twiz_time_/, wizard.handleTmplTimeCallback);
  bot.callbackQuery(/^twiz_opt_/, wizard.handleTmplOptionsCallback);
  bot.callbackQuery(/^tmpl_/, commands.handleTemplateCallback);
  bot.callbackQuery("bugreport_skip", wizard.handleBugReportSkip);
  // Models a read-only message handler, such as the forwarded-raffle redirect,
  // that deliberately consumes an update before the workflow input router.
  bot.on("message", async (ctx, next) => {
    if (settings.interceptMessage) { await ctx.reply("Read-only response"); return; }
    await next();
  });
  bot.on("message", wizard.handleWorkflowMessage);

  async function text(value: string, user = USER, chatId = user, threadId?: number) {
    await bot.handleUpdate({ update_id: ++id, message: { message_id: ++id, date: 1,
      from: { id: user, is_bot: false, first_name: "Test" },
      chat: chatId > 0 ? { id: chatId, type: "private", first_name: "Test" } : { id: chatId, type: "supergroup", title: "Test Group" },
      text: value, message_thread_id: threadId, ...(threadId ? { reply_to_message: { message_id: threadId, date: 1, chat: { id: chatId, type: "supergroup" as const, title: "Test Group" }, forum_topic_created: { name: "New Raffles", icon_color: 0 } } } : {}), ...(value.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: value.split(" ")[0].length }] } : {}) } });
  }
  async function rawClick(data: string, messageId: number, user = USER, chatId = user) {
    await bot.handleUpdate({ update_id: ++id, callback_query: { id: String(++id), from: { id: user, is_bot: false, first_name: "Test" }, chat_instance: "test", data,
      message: { message_id: messageId, date: 1, from: info, chat: chatId > 0 ? { id: chatId, type: "private", first_name: "Test" } : { id: chatId, type: "supergroup", title: "Test Group" }, text: "Controls" } } });
  }
  function button(data: string, user = USER) {
    const session = getWorkflow(user);
    const token = [...(session?.controls ?? [])].find(([, original]) => original === data)?.[0];
    if (!token) throw new Error(`No active button: ${data}`);
    // Verify that the token was really sent in a Telegram keyboard.
    const record = [...calls].reverse().find(call => call.payload.reply_markup?.inline_keyboard?.flat().some((b: { callback_data?: string }) => b.callback_data === token));
    if (!record || record.messageId !== session!.controlMessageId) throw new Error("Button was not rendered");
    return { data: token, messageId: session!.controlMessageId! };
  }
  const click = async (data: string, user = USER) => {
    const b = button(data, user); await rawClick(b.data, b.messageId, user);
  };
  async function photo(user = USER) {
    await bot.handleUpdate({ update_id: ++id, message: { message_id: ++id, date: 1, from: { id: user, is_bot: false, first_name: "Test" }, chat: { id: user, type: "private", first_name: "Test" }, photo: [{ file_id: "uploaded", file_unique_id: "uploaded", width: 100, height: 100 }] } });
  }
  async function start(kind: "raffle" | "edit" | "template" | "bug", user = USER, raffleId?: number) {
    if (kind === "raffle") await rawClick(`admin_do_create_${GROUP}`, 1, user);
    if (kind === "template") await text(`/start tmpl_${GROUP}`, user);
    if (kind === "bug") await rawClick(`admin_bug_${GROUP}`, 1, user);
    if (kind === "edit") await rawClick(`edit_pick_${raffleId ?? createRaffle(user).id}`, 1, user);
  }
  return { bot, calls, settings, text, rawClick, button, click, photo, start };
}

export function createRaffle(user = USER) {
  return db.createRaffle({ chat_id: GROUP, thread_id: 124, creator_id: user, creator_name: "Test", title: "Original", description: "", prize: "Prize", prizes: null, max_entries: null, max_winners: 1, ends_at: null, starts_at: null, display_timezone: "UTC", required_chat_id: null, required_chat_title: null, sponsor_name: null, anonymous: 0, image_file_id: null, auto_pin: 0, min_account_age_days: 0, require_username: 0, winner_cooldown: 0, show_animation: 0, referral_enabled: 0, max_referral_entries: 0, revoke_referral_links: 0 });
}
