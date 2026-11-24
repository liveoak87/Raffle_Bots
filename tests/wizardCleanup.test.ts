import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";

vi.mock("../src/banners", () => ({
  sendRafflePost: vi.fn(),
  sendCustomImage: vi.fn(),
}));

describe("raffle creation setup lifecycle", () => {
  let db: typeof import("../src/database");
  let wizard: typeof import("../src/wizard");
  let banners: typeof import("../src/banners");
  let workflows: typeof import("../src/workflowSessions");
  let bot: Bot;
  let messageId: number;
  let updateId: number;
  let failPrompt: boolean;
  let failEdits: boolean;
  let holdDelete: (() => Promise<void>) | undefined;
  let holdSend: (() => Promise<void>) | undefined;
  let calls: Array<{ method: string; payload: Record<string, any>; messageId?: number }>;
  const userId = 8723884396;
  const groupId = -1004491315719;
  const from = { id: userId, first_name: "Creator", is_bot: false };
  const info = { id: 1234, is_bot: true as const, first_name: "Raffle", username: "AuditRaffleBot" };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    db.upsertBotGroup(groupId, "Test Group", "administrator");
    db.upsertGroupDefaults(groupId, { thread_id: 124, thread_name: "RAFFLE" });
    wizard = await import("../src/wizard");
    workflows = await import("../src/workflowSessions");
    banners = await import("../src/banners");
    vi.mocked(banners.sendRafflePost).mockReset().mockResolvedValue(999);
    messageId = 100;
    updateId = 0;
    calls = [];
    failPrompt = false;
    failEdits = false;
    holdDelete = undefined;
    holdSend = undefined;
    bot = new Bot("1234:test-only", { botInfo: info });
    bot.use(workflows.workflowMiddleware);
    bot.api.config.use(async (_prev, method, payload) => {
      const record = { method, payload: payload as Record<string, any>, messageId: undefined as number | undefined };
      calls.push(record);
      if (method === "sendMessage") {
        if (failPrompt) throw new Error("prompt failed");
        if (holdSend) await holdSend();
        record.messageId = ++messageId;
        return { ok: true, result: { message_id: messageId, date: 1, text: record.payload.text, chat: { id: record.payload.chat_id, type: "private" } } };
      }
      if (method === "getChatMember") return { ok: true, result: { status: "creator", user: from } };
      if (method === "getChat") return { ok: true, result: { id: groupId, type: "supergroup", title: "Test Group" } };
      if (method === "deleteMessages") {
        if (holdDelete) await holdDelete();
        return { ok: true, result: true };
      }
      if (method === "editMessageText" && failEdits) throw new Error("edit failed");
      if (["answerCallbackQuery", "editMessageText", "editMessageReplyMarkup", "deleteMessage"].includes(method)) return { ok: true, result: true };
      throw new Error(`Unexpected API call: ${method}`);
    });
    bot.command("newraffle", wizard.startWizard);
    bot.command("start", async ctx => { await wizard.handleStartDeepLink(ctx, String(ctx.match)); });
    bot.callbackQuery("create", async ctx => { await wizard.startRaffleWizardForGroup(ctx, groupId, "Test Group"); });
    bot.callbackQuery(/^wiz_winners_\d+$/, wizard.handleWinnersCallback);
    bot.callbackQuery("wiz_winners_custom", wizard.handleWinnersCustomCallback);
    bot.callbackQuery(/^wiz_time_/, wizard.handleTimeCallback);
    bot.callbackQuery(/^wiz_opt_/, wizard.handleOptionsCallback);
    bot.callbackQuery(/^wsc:/, wizard.handleCalendarPickerCallback);
    bot.on("message", wizard.handleWorkflowMessage);
  });

  afterEach(() => {
    db.getDb().close();
    vi.useRealTimers();
  });

  async function text(value: string, chatId = userId) {
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: ++messageId, date: 1, from,
        chat: chatId > 0 ? { id: chatId, type: "private", first_name: "Creator" } : { id: chatId, type: "supergroup", title: "Test Group" },
        text: value,
        ...(value.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: value.split(" ")[0].length }] } : {}),
      },
    });
  }

  async function click(data: string) {
    const session = workflows.getWorkflow(userId);
    const token = [...(session?.controls ?? [])].find(([, original]) => original === data)?.[0];
    const lastMessage = token ? session!.controlMessageId! : 1;
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: { id: String(updateId), from, chat_instance: "audit", data: token ?? data,
        message: { message_id: lastMessage, date: 1, from: info, chat: { id: userId, type: "private", first_name: "Creator" }, text: "Setup" } },
    });
  }

  const sentIds = () => calls.filter(call => call.method === "sendMessage").map(call => call.messageId);
  const deletedIds = () => calls.filter(call => call.method === "deleteMessages").flatMap(call => call.payload.message_ids);
  async function toOptions() {
    await text("GLOW & GROW RAFFLE 💗");
    await text("Gift card");
    await click("wiz_winners_1");
    await click("wiz_time_none");
  }

  it.each(["button", "group command", "deep link"])("cleans %s setup after creation, preserving the menu, confirmation, and group post", async entry => {
    await bot.api.sendMessage(userId, "Admin menu");
    const menuId = messageId;
    if (entry === "button") await click("create");
    if (entry === "group command") await text("/newraffle", groupId);
    if (entry === "deep link") await text(`/start newraffle_${groupId}`);
    await toOptions();
    const setupIds = sentIds().filter(id => id !== menuId);
    await click("wiz_opt_create");

    expect(deletedIds()).toEqual(setupIds);
    expect(deletedIds()).not.toContain(menuId);
    expect(deletedIds()).not.toContain(999);
    expect(deletedIds()).not.toContain(messageId);
    expect(calls.filter(call => call.method === "sendMessage").at(-1)?.payload.text).toContain("has been posted");
    expect(wizard.getActiveWizard(userId)).toBeUndefined();
    expect(db.getOpenRafflesForChat(groupId)).toHaveLength(1);
    expect(calls.filter(call => call.method === "deleteMessages").every(call => call.payload.chat_id === userId)).toBe(true);
  });

  it("tracks validation, custom input, and fallback picker messages", async () => {
    await click("create"); await text("Title"); await text(",,,"); await text("Prize");
    await click("wiz_winners_custom"); await text("invalid"); await text("2"); await click("wiz_time_none");
    failEdits = true;
    const beforePicker = sentIds().length;
    await click("wiz_opt_sched");
    expect(sentIds()).toHaveLength(beforePicker + 1);
    expect([...workflows.getWorkflow(userId)!.controls.values()].some(data => data.startsWith("wsc:"))).toBe(true);
    failEdits = false;
    const setupIds = sentIds();
    await wizard.cancelWizard(userId);
    expect(deletedIds()).toEqual(setupIds);
  });

  it("expires setup with no further user input when the background sweep runs", async () => {
    await click("create"); const setupIds = sentIds();
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await wizard.cleanupExpiredRaffleWizards();
    expect(deletedIds()).toEqual(setupIds);
    expect(wizard.getActiveWizard(userId)).toBeUndefined();
    await click("wiz_winners_1");
    expect(calls.at(-1)?.payload.text).toContain("expired");
  });

  it("keeps a draft alive after recent input and later cleans every setup message", async () => {
    await click("create");
    vi.setSystemTime(Date.now() + 29 * 60_000); await text("Title");
    vi.setSystemTime(Date.now() + 2 * 60_000); await wizard.cleanupExpiredRaffleWizards();
    expect(deletedIds()).toEqual([]);
    vi.setSystemTime(Date.now() + 28 * 60_000); await wizard.cleanupExpiredRaffleWizards();
    expect(deletedIds()).toEqual(sentIds());
  });

  it("retains retry controls when posting fails, then cleans them after success", async () => {
    await click("create"); await toOptions();
    vi.mocked(banners.sendRafflePost).mockResolvedValueOnce(null);
    await click("wiz_opt_create");
    expect(deletedIds()).toEqual([]);
    expect(wizard.getActiveWizard(userId)?.step).toBe("options");
    const setupIds = sentIds();
    await click("wiz_opt_create");
    expect(deletedIds()).toEqual(setupIds);
  });

  it("replaces old setup boxes without deleting the new draft", async () => {
    await click("create"); await text("Old title"); const oldIds = sentIds();
    await click("create"); const newId = messageId;
    expect(deletedIds()).toEqual(oldIds);
    expect(deletedIds()).not.toContain(newId);
    await text("New title");
    expect(wizard.getActiveWizard(userId)?.title).toBe("New title");
  });

  it("keeps the old draft and its messages when the replacement prompt fails", async () => {
    await click("create"); await text("Saved title");
    failPrompt = true;
    await expect(click("create")).rejects.toThrow("prompt failed");
    expect(wizard.getActiveWizard(userId)?.title).toBe("Saved title");
    expect(deletedIds()).toEqual([]);
  });

  it("an old timeout cleanup cannot delete a newer draft while its API call is pending", async () => {
    await click("create"); const oldIds = sentIds();
    let release!: () => void;
    holdDelete = () => new Promise<void>(resolve => { release = resolve; });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    const cleaning = wizard.cleanupExpiredRaffleWizards();
    await Promise.resolve();
    await click("create"); const newId = messageId;
    holdDelete = undefined; release(); await cleaning;
    expect(deletedIds()).toEqual(oldIds);
    expect(deletedIds()).not.toContain(newId);
    expect(wizard.getActiveWizard(userId)).toBeDefined();
  });

  it("cleans an initial prompt that arrives after its draft has already expired", async () => {
    let release!: () => void;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    holdSend = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
    const creating = click("create"); await sending;
    vi.setSystemTime(Date.now() + 30 * 60_000); await wizard.cleanupExpiredRaffleWizards();
    holdSend = undefined; release(); await creating;
    expect(deletedIds()).toEqual(sentIds());
    expect(wizard.getActiveWizard(userId)).toBeUndefined();
  });
});
