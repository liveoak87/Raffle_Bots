import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/database";
import * as commands from "../src/commands";
import { sendWinnerPost } from "../src/banners";
import { refreshOpenRafflePost, pruneRenderedPosts } from "../src/rafflePost";
import { formatRaffleMessage, escapeCsvCell } from "../src/helpers";
import { createRaffle, GROUP } from "./workflowHarness";
import { enqueueOnce, processJobs, registerHandler } from "../src/jobs";

vi.mock("../src/banners", () => ({ sendWinnerPost: vi.fn(), sendWheelSpin: vi.fn(), editClosedBanner: vi.fn(), sendRafflePost: vi.fn(async () => 999), sendCustomImage: vi.fn() }));

function context(data: string, userId = 10, status = "creator") {
  const api = {
    getChatMember: vi.fn(async () => ({ status })),
    getChat: vi.fn(async () => ({ title: "Audit Group" })),
    sendMessage: vi.fn(async () => ({ message_id: 100 })),
    editMessageCaption: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
    editMessageMedia: vi.fn(async () => true),
    revokeChatInviteLink: vi.fn(async () => true),
  };
  return {
    api, from: { id: userId, first_name: "Audit", username: "audit" }, me: { id: 1234, username: "AuditBot" },
    chat: { id: userId, type: "private" }, callbackQuery: { data, message: { chat: { id: GROUP }, message_id: 50 } },
    answerCallbackQuery: vi.fn(async () => true), editMessageText: vi.fn(async () => true), reply: vi.fn(async () => true),
  } as any;
}
function raffle(options: Record<string, unknown> = {}) {
  const r = createRaffle(10);
  db.updateRaffleFields(r.id, { show_animation: 0, ...options });
  return db.getRaffleById(r.id)!;
}

describe("raffle lifecycle audit", () => {
  beforeEach(() => { vi.useFakeTimers(); db.initDatabase(":memory:"); vi.mocked(sendWinnerPost).mockReset().mockResolvedValue(undefined); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); db.getDb().close(); });

  it("allows approved /active viewers by Telegram ID in private chats only", async () => {
    vi.stubEnv("BOT_OWNER_ID", "10");
    vi.stubEnv("ACTIVE_RAFFLE_VIEWER_IDS", "20, 8311000000, 99invalid");
    raffle();

    const viewer = context("", 8311000000);
    await commands.handleActive(viewer);
    expect(viewer.reply).toHaveBeenCalledWith(expect.stringContaining("Original"), expect.any(Object));
    viewer.reply.mockClear();
    await commands.handleStats(viewer);
    expect(viewer.reply).not.toHaveBeenCalled();
    expect(viewer.api.sendMessage).not.toHaveBeenCalled();

    const groupContext = { id: GROUP, type: "supergroup" };
    viewer.chat = groupContext;
    await commands.handleActive(viewer);
    expect(viewer.reply).not.toHaveBeenCalled();

    const owner = context("", 10);
    owner.chat = groupContext;
    await commands.handleActive(owner);
    expect(owner.reply).toHaveBeenCalledWith(expect.stringContaining("Original"), expect.any(Object));

    const unapproved = context("", 99);
    await commands.handleActive(unapproved);
    expect(unapproved.reply).not.toHaveBeenCalled();

    vi.stubEnv("ACTIVE_RAFFLE_VIEWER_IDS", undefined);
    const formerViewer = context("", 20);
    await commands.handleActive(formerViewer);
    expect(formerViewer.reply).not.toHaveBeenCalled();
  });

  it("retains winners and a retryable announcement after a manual draw delivery failure", async () => {
    const r = raffle(); db.addEntry(r.id, 20, "entry", "Entrant");
    vi.mocked(sendWinnerPost).mockRejectedValue(new Error("network offline"));
    const ctx = context(`draw_confirm_${GROUP}_${r.id}`);
    await commands.handleDrawCallback(ctx);
    expect(db.getRaffleById(r.id)).toMatchObject({ status: "drawn", announced: 0 });
    const winners = db.getWinnersForRaffle(r.id);
    expect(winners).toHaveLength(1);
    expect(db.getDb().prepare("SELECT count(*) AS n FROM jobs WHERE status='pending'").get()).toEqual({ n: 2 });
    await commands.handleDrawCallback(ctx);
    expect(db.getWinnersForRaffle(r.id)).toEqual(winners);
    expect(sendWinnerPost).toHaveBeenCalledTimes(1);
  });

  it("claims the draw once when two admins confirm while Telegram is slow", async () => {
    const r = raffle();
    db.addEntry(r.id, 20, "entry", "Entrant");
    let release!: () => void;
    const outstanding = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(sendWinnerPost).mockImplementation(() => outstanding);
    const confirm = `draw_confirm_${GROUP}_${r.id}`;
    const tasks = [10, 11].map(id => commands.handleDrawCallback(context(confirm, id)));
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.isAnnouncingDraw(r.id)).toBe(true);
    expect(sendWinnerPost).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(tasks);
    expect(commands.isAnnouncingDraw(r.id)).toBe(false);
    expect(db.getRaffleById(r.id)).toMatchObject({ status: "drawn", announced: 1 });
  });

  it("caps simultaneous entries and draws once even when the public post fails", async () => {
    const r = raffle({ max_entries: 10 });
    vi.mocked(sendWinnerPost).mockRejectedValue(new Error("offline"));
    await Promise.all(Array.from({ length: 100 }, (_, i) => commands.handleEnterCallback(context(`enter_${r.id}`, 1000 + i))));
    expect(db.getEntryCount(r.id)).toBe(10);
    expect(db.getRaffleById(r.id)).toMatchObject({ status: "drawn", announced: 0 });
    expect(db.getWinnersForRaffle(r.id)).toHaveLength(1);
    expect(sendWinnerPost).toHaveBeenCalledTimes(1);
  });

  it("reuses an accepted render across a burst of entries and later timer refreshes", async () => {
    const r = raffle();
    db.updateRaffleMessageId(r.id, 567);
    pruneRenderedPosts(new Set());
    const first = context(`enter_${r.id}`, 30);
    await commands.handleEnterCallback(first);
    await vi.advanceTimersByTimeAsync(2_501);
    expect(first.api.editMessageCaption).toHaveBeenCalledTimes(1);

    const entrants = Array.from({ length: 10 }, (_, i) => context(`enter_${r.id}`, 50 + i));
    for (const ctx of entrants) await commands.handleEnterCallback(ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const api = first.api;
    await refreshOpenRafflePost(api, r.id, first.me.username);
    const burstEdits = entrants.flatMap(ctx => ctx.api.editMessageCaption.mock.calls);
    expect(burstEdits).toHaveLength(2);
    expect(burstEdits.at(-1)[2].caption).toContain("Entries:</b> 11");
    expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
  });

  it("learns the type of a split text post and reconciles it again after reposting", async () => {
    const r = raffle();
    pruneRenderedPosts(new Set());
    const ctx = context("");
    db.updateRaffleMessageId(r.id, 50);
    ctx.api.editMessageCaption.mockRejectedValueOnce({ error_code: 400, description: "no caption" });
    ctx.api.editMessageText.mockRejectedValueOnce({ error_code: 400, description: "message is not modified" });
    await refreshOpenRafflePost(ctx.api, r.id, ctx.me.username);
    await refreshOpenRafflePost(ctx.api, r.id, ctx.me.username);
    expect(ctx.api.editMessageText).toHaveBeenCalledTimes(1);
    db.updateRaffleMessageId(r.id, 51);
    await refreshOpenRafflePost(ctx.api, r.id, ctx.me.username);
    expect(ctx.api.editMessageCaption.mock.calls.map((call: any[]) => call[1])).toEqual([50, 51]);
    expect(ctx.api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("completes a capped draw even when the last entrant's callback expired", async () => {
    const r = raffle({ max_entries: 1 });
    const ctx = context(`enter_${r.id}`, 20);
    ctx.answerCallbackQuery.mockRejectedValue({ error_code: 400, description: "query is too old" });
    await commands.handleEnterCallback(ctx);
    expect(db.getRaffleById(r.id)).toMatchObject({ status: "drawn", announced: 1 });
    expect(db.getWinnersForRaffle(r.id).map(w => w.user_id)).toEqual([20]);
    expect(db.getDb().prepare("SELECT type FROM jobs ORDER BY type").all()).toEqual([
      { type: "notify_winners" }, { type: "revoke_referrals" },
    ]);
  });

  it("rolls the last entry and draw back together if recovery jobs cannot be saved", async () => {
    const r = raffle({ max_entries: 1 });
    db.getDb().exec("CREATE TRIGGER fail_queue BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'queue failed'); END");
    await expect(commands.handleEnterCallback(context(`enter_${r.id}`, 20))).rejects.toThrow("queue failed");
    expect(db.getEntryCount(r.id)).toBe(0);
    expect(db.getWinnersForRaffle(r.id)).toHaveLength(0);
    expect(db.getRaffleById(r.id)?.status).toBe("open");
  });

  it("keeps the caption stable across countdown ticks, including the configured timezone", () => {
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    const r = raffle({ ends_at: "2026-11-24 12:10:00", display_timezone: "America/New_York" });
    const before = formatRaffleMessage(r, 0);
    expect(before).toContain(`<tg-time unix="${Date.parse("2026-11-24T12:10:00Z") / 1000}" format="r">`);
    expect(before).toContain("7:10 AM EST");
    vi.advanceTimersByTime(5 * 60_000);
    expect(formatRaffleMessage(r, 0)).toBe(before);
  });

  it("records a forbidden announcement as failed instead of delivered", async () => {
    const r = raffle(); db.addEntry(r.id, 20, "entry", "Entrant");
    vi.mocked(sendWinnerPost).mockRejectedValue({ error_code: 403 });
    await commands.handleDrawCallback(context(`draw_confirm_${GROUP}_${r.id}`));
    expect(db.getRaffleById(r.id)).toMatchObject({ announced: 0, announce_failed: 1 });
  });

  it("denies ordinary members draw, cancel, and template access", async () => {
    const r = raffle(); db.addEntry(r.id, 20, "entry", "Entrant");
    await commands.handleDrawCallback(context(`draw_confirm_${GROUP}_${r.id}`, 99, "member"));
    await commands.handleCancelCallback(context(`cancel_yes_${r.id}`, 99, "member"));
    const ctx = context(`tmpl_back_${GROUP}`, 99, "member");
    await commands.handleTemplateCallback(ctx);
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(db.getRaffleById(r.id)?.status).toBe("open");
    expect(db.getWinnersForRaffle(r.id)).toHaveLength(0);
  });

  it("enforces membership gating and rejects leaving a completed raffle", async () => {
    const r = raffle({ required_chat_id: -100999 });
    await commands.handleEnterCallback(context(`enter_${r.id}`, 30, "left"));
    expect(db.getEntryCount(r.id)).toBe(0);
    await commands.handleEnterCallback(context(`enter_${r.id}`, 30, "member"));
    expect(db.getEntryCount(r.id)).toBe(1);
    db.markRaffleDrawn(r.id);
    await commands.handleLeaveCallback(context(`leave_${r.id}`, 30));
    expect(db.getEntryCount(r.id)).toBe(1);
  });

  it("retries only failed DM recipients through the persistent job queue", async () => {
    const r = raffle(); const winners = [20, 21].map((user_id, i) => ({ user_id, user_display_name: "Winner", prize: "Prize", position: i + 1 }));
    let fail = true; const recipients: number[] = [];
    const api = { getChat: vi.fn(async () => ({ title: "Group" })), sendMessage: vi.fn(async (id: number) => { recipients.push(id); if (id === 21 && fail) throw new Error("offline"); }) };
    registerHandler("audit_notify", () => commands.notifyWinnersAndCreator(api, r, winners));
    enqueueOnce("audit_notify", { raffleId: r.id });
    await processJobs();
    expect(db.getDb().prepare("SELECT status FROM jobs").get()).toEqual({ status: "pending" });
    fail = false; db.getDb().prepare("UPDATE jobs SET run_after=datetime('now')").run();
    await processJobs();
    expect(recipients.filter(id => id === 20)).toHaveLength(1);
    expect(recipients.filter(id => id === 21)).toHaveLength(2);
    expect(recipients.filter(id => id === 10)).toHaveLength(1);
    expect(db.getDb().prepare("SELECT status FROM jobs").get()).toEqual({ status: "done" });
  });

  it("does not retry blocked DMs and retains successful delivery receipts", async () => {
    const r = raffle(); const api = { getChat: vi.fn(async () => ({ title: "Group" })), sendMessage: vi.fn(async (id: number) => { if (id === 20) throw { error_code: 403 }; }) };
    const winners = [{ user_id: 20, user_display_name: "Winner", prize: "Prize", position: 1 }];
    await commands.notifyWinnersAndCreator(api, r, winners);
    await commands.notifyWinnersAndCreator(api, r, winners);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(db.getDb().prepare("SELECT outcome FROM delivery_receipts WHERE kind='winner_dm'").get()).toEqual({ outcome: "unreachable" });
  });

  it("propagates transient invite revocation failures for durable retry", async () => {
    const r = raffle({ referral_enabled: 1, revoke_referral_links: 1 });
    db.createReferralLink(r.id, 20, "Referrer", GROUP, "https://t.me/+audit");
    const api = { revokeChatInviteLink: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true) };
    await expect(commands.revokeReferralInviteLinks(api, r.id)).rejects.toThrow();
    await commands.revokeReferralInviteLinks(api, r.id);
    await commands.revokeReferralInviteLinks(api, r.id);
    expect(api.revokeChatInviteLink).toHaveBeenCalledTimes(2);
  });

  it("neutralizes spreadsheet formulas preceded by whitespace", () => {
    expect(escapeCsvCell("\t=1+1")).toBe('"\'\t=1+1"');
    expect(escapeCsvCell('Name "quoted"')).toBe('"Name ""quoted"""');
  });
});

describe("referral eligibility counts", () => {
  it("excludes referral bonuses from entrants who have left", () => {
    db.initDatabase(":memory:");
    const r = createRaffle(10); db.updateRaffleFields(r.id, { referral_enabled: 1 });
    db.addEntry(r.id, 20, "referrer", "Referrer");
    const link = db.createReferralLink(r.id, 20, "Referrer", GROUP, "https://t.me/+count");
    db.awardReferralBonus(link.id, r.id, 99, 0);
    expect(db.getTotalEntryCount(r.id)).toBe(2);
    db.removeEntry(r.id, 20);
    expect(db.getTotalEntryCount(r.id)).toBe(0);
    db.getDb().close();
  });
});
