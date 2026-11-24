import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/database";
import * as wizard from "../src/wizard";
import { expireWorkflows, getWorkflow, WORKFLOW_TIMEOUT_MS } from "../src/workflowSessions";
import { workflowHarness, createRaffle, GROUP, USER } from "./workflowHarness";

vi.mock("../src/banners", () => ({ sendRafflePost: vi.fn(async () => 999), sendCustomImage: vi.fn() }));

describe("shared workflow regression tests", () => {
  let h: ReturnType<typeof workflowHarness>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    db.initDatabase(":memory:");
    db.upsertBotGroup(GROUP, "Test Group", "administrator");
    h = workflowHarness();
  });
  afterEach(async () => {
    vi.setSystemTime(Date.now() + WORKFLOW_TIMEOUT_MS + 1);
    await expireWorkflows();
    db.getDb().close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const kinds = ["raffle", "edit", "template", "bug"] as const;
  it("binds the group topic command's continuation to the current raffle", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize");
    await h.click("wiz_winners_1"); await h.click("wiz_time_none");
    await h.click("wiz_opt_destination");
    const old = h.button("wiz_opt_destination_back");
    await h.text("/setraffletopic New Raffles", USER, GROUP, 456);
    const fresh = h.button("wiz_opt_destination_back");
    expect(fresh.data).not.toBe(old.data);
    await h.click("wiz_opt_destination_back");
    expect(wizard.getActiveWizard(USER)?.step).toBe("options");
    expect(wizard.getActiveWizard(USER)?.targetThreadId).toBe(456);
  });
  it("keeps a group topic update when a later DM prompt fails", async () => {
    await h.start("raffle");
    await h.text("/setraffletopic New Raffles", USER, GROUP, 456);
    let failed = false;
    h.settings.fail = (method, p) => {
      if (!failed && method === "sendMessage" && p.text.includes("Step 2 of 4")) { failed = true; return true; }
      return false;
    };
    await h.text("Title");
    expect(wizard.getActiveWizard(USER)?.step).toBe("title");
    expect(wizard.getActiveWizard(USER)?.targetThreadId).toBe(456);
    await h.text("Retried title");
    expect(wizard.getActiveWizard(USER)?.step).toBe("prize");
    expect(wizard.getActiveWizard(USER)?.targetThreadId).toBe(456);
  });
  it.each(kinds.flatMap(from => kinds.map(to => [from, to] as const)))("switches %s → %s with exactly one active workflow", async (from, to) => {
    await h.start(from);
    if (from === "edit") await h.click("edit_max");
    if (from === "template") { await h.text("Template"); await h.text("Title"); await h.text("Prize"); }
    if (from === "bug") await h.text("Description");
    const oldId = getWorkflow(USER)!.id;
    await h.start(to);
    expect(getWorkflow(USER)?.kind).toBe(to);
    expect(getWorkflow(USER)?.id).not.toBe(oldId);
    expect([wizard.getActiveWizard(USER), wizard.getActiveEditWizard(USER), wizard.getActiveTemplateWizard(USER), wizard.getActiveBugReport(USER)].filter(Boolean)).toHaveLength(1);
    if (to === "raffle") { await h.text("THE GLOW COLLECTION RAFFLE ❤️‍🔥"); expect(wizard.getActiveWizard(USER)?.step).toBe("prize"); }
  });
  it.each(kinds)("cancels %s before rate limiting and preserves published raffles", async kind => {
    const existing = createRaffle(); await h.start(kind);
    h.settings.blockCommands = true;
    await h.text("/cancel@WorkflowTestBot");
    expect(Boolean(getWorkflow(USER))).toBe(false);
    expect(db.getRaffleById(existing.id)?.status).toBe("open");
    await h.text("/cancel");
    expect(h.calls.at(-1)?.payload.text).toContain("no active setup");
  });
  it("ignores cancellation in groups or addressed to another bot", async () => {
    await h.start("raffle"); const id = getWorkflow(USER)!.id; h.calls.length = 0;
    await h.text("/cancel@OtherBot"); await h.text("/cancel", USER, GROUP);
    expect(getWorkflow(USER)?.id).toBe(id);
    expect(h.calls.filter(c => c.method === "deleteMessage")).toHaveLength(0);
  });
  it.each(["home_main", "admin_groups", "/start", "/manage"])("leaves the active workflow on %s", async destination => {
    await h.start("edit"); await h.click("edit_max");
    if (destination.startsWith("/")) await h.text(destination); else await h.rawClick(destination, 1);
    expect(Boolean(getWorkflow(USER))).toBe(false);
  });
  it("viewing history preserves the draft and does not refresh its inactivity deadline", async () => {
    createRaffle(); await h.start("raffle"); const lastActivity = getWorkflow(USER)!.state.createdAt;
    vi.setSystemTime(Date.now() + 20 * 60_000); await h.rawClick(`admin_do_history_${GROUP}`, 1);
    expect(getWorkflow(USER)!.state.createdAt).toBe(lastActivity);
    expect(h.calls.some(c => c.payload.text?.includes("Recent Raffles"))).toBe(true);
    await h.text("Title"); expect(wizard.getActiveWizard(USER)?.step).toBe("prize");
  });
  it.each(kinds)("expires %s consistently; reads do not extend the timeout", async kind => {
    await h.start(kind); const then = Date.now();
    vi.setSystemTime(then + 29 * 60_000); expect(getWorkflow(USER)).toBeDefined();
    wizard.getActiveWizard(USER); wizard.getActiveEditWizard(USER); wizard.getActiveTemplateWizard(USER); wizard.getActiveBugReport(USER);
    vi.setSystemTime(then + WORKFLOW_TIMEOUT_MS); await expireWorkflows(); expect(Boolean(getWorkflow(USER))).toBe(false);
  });
  it("real bug-report input refreshes its inactivity deadline", async () => {
    await h.start("bug"); vi.setSystemTime(Date.now() + 29 * 60_000); await h.text("Description");
    vi.setSystemTime(Date.now() + 2 * 60_000); await expireWorkflows(); expect(getWorkflow(USER)?.kind).toBe("bug");
  });
  it("rejects an old winners button even when the new draft is at the same step", async () => {
    await h.start("raffle"); await h.text("Old"); await h.text("Prize"); const old = h.button("wiz_winners_7");
    await h.start("raffle"); await h.text("New"); await h.text("Prize");
    const before = getWorkflow(USER)!.state.createdAt; vi.setSystemTime(Date.now() + 1000);
    await h.rawClick(old.data, old.messageId);
    expect(wizard.getActiveWizard(USER)?.step).toBe("winners");
    expect(wizard.getActiveWizard(USER)?.maxWinners).toBeUndefined();
    expect(getWorkflow(USER)!.state.createdAt).toBe(before);
  });
  it("old edit controls cannot rename the newly selected raffle", async () => {
    const a = createRaffle(), b = createRaffle(); await h.start("edit", USER, a.id); const old = h.button("edit_title");
    await h.start("edit", USER, b.id); await h.rawClick(old.data, old.messageId); await h.text("Wrong title");
    expect(db.getRaffleById(a.id)?.title).toBe("Original"); expect(db.getRaffleById(b.id)?.title).toBe("Original");
  });
  it("rejects duplicate same-message toggles after a keyboard refresh", async () => {
    const raffle = createRaffle(); await h.start("edit", USER, raffle.id); const button = h.button("edit_anon");
    await h.rawClick(button.data, button.messageId); await h.rawClick(button.data, button.messageId);
    expect(db.getRaffleById(raffle.id)?.anonymous).toBe(1);
  });
  it("rejects copied controls in another message, another user, or a group", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); const button = h.button("wiz_winners_2");
    await h.rawClick(button.data, button.messageId + 500);
    await h.rawClick(button.data, button.messageId, USER + 1);
    await h.rawClick(button.data, button.messageId, USER, GROUP);
    expect(wizard.getActiveWizard(USER)?.step).toBe("winners");
  });
  it("rejects pre-upgrade unbound workflow buttons", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); await h.rawClick("wiz_winners_2", 1);
    expect(wizard.getActiveWizard(USER)?.step).toBe("winners");
  });
  it("restores the title step after failed step-2 delivery; retry remains a title", async () => {
    await h.start("raffle"); let failed = false;
    h.settings.fail = (method, p) => { if (!failed && method === "sendMessage" && p.text.includes("Step 2 of 4")) { failed = true; return true; } return false; };
    await h.text("First title"); expect(wizard.getActiveWizard(USER)?.step).toBe("title");
    expect(h.calls.filter(c => c.method === "sendMessage").at(-1)?.payload.text).toContain("Step 1 of 4");
    await h.text("Retried title"); expect(wizard.getActiveWizard(USER)?.title).toBe("Retried title"); expect(wizard.getActiveWizard(USER)?.prizes).toBeUndefined();
  });
  it("does not consume user input while prompt recovery is still failing", async () => {
    await h.start("raffle"); h.settings.fail = method => method === "sendMessage";
    await h.text("Title"); expect(getWorkflow(USER)?.recovering).toBe(true);
    await h.text("Not a prize"); expect(wizard.getActiveWizard(USER)?.title).toBeUndefined();
    h.settings.fail = undefined; await h.text("Still only resumes"); expect(wizard.getActiveWizard(USER)?.step).toBe("title");
    await h.text("Actual title"); expect(wizard.getActiveWizard(USER)?.title).toBe("Actual title");
  });
  it("recovers failed edit confirmation from actual database state without repeating a toggle", async () => {
    const raffle = createRaffle(); await h.start("edit", USER, raffle.id); const old = h.button("edit_anon");
    let failed = false; h.settings.fail = method => { if (method === "editMessageText" && !failed) { failed = true; return true; } return false; };
    await h.rawClick(old.data, old.messageId);
    expect(db.getRaffleById(raffle.id)?.anonymous).toBe(1);
    await h.rawClick(old.data, old.messageId); expect(db.getRaffleById(raffle.id)?.anonymous).toBe(1);
  });
  it("a rejected new workflow preserves the old draft", async () => {
    await h.start("raffle"); await h.text("Saved"); const id = getWorkflow(USER)!.id;
    h.settings.memberStatus = "member"; await h.start("template"); expect(getWorkflow(USER)?.id).toBe(id); expect(wizard.getActiveWizard(USER)?.title).toBe("Saved");
  });
  it("a failed replacement prompt preserves the previous workflow", async () => {
    await h.start("raffle"); await h.text("Saved"); const id = getWorkflow(USER)!.id;
    h.settings.fail = (method, p) => method === "sendMessage" && p.text.includes("Create a Template");
    await h.start("template"); expect(getWorkflow(USER)?.id).toBe(id); expect(wizard.getActiveWizard(USER)?.title).toBe("Saved");
  });
  it("unexpected input gives guidance without invalidating the current buttons", async () => {
    await h.start("bug"); await h.text("Description"); const button = h.button("bugreport_skip");
    await h.text("Not a screenshot"); expect(h.calls.at(-1)?.payload.text).toContain("Send a photo");
    expect(h.button("bugreport_skip")).toEqual(button);
  });
  it("photo input is routed to a new creation after leaving the edit screen", async () => {
    await h.start("edit"); await h.start("raffle"); await h.text("Title"); await h.text("Prize"); await h.click("wiz_winners_1"); await h.click("wiz_time_none"); await h.click("wiz_opt_image");
    await h.photo(); expect(wizard.getActiveWizard(USER)?.imageFileId).toBe("uploaded"); expect(wizard.getActiveWizard(USER)?.step).toBe("options");
  });
  it("a delayed group start is serialized with subsequent DM input", async () => {
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.settings.delay = async (method, p) => { if (method === "sendMessage" && p.text.includes("Step 1 of 4")) { entered(); await gate; } };
    const starting = h.text("/newraffle", USER, GROUP); await ready;
    const title = h.text("Queued title"); release(); await Promise.all([starting, title]);
    expect(wizard.getActiveWizard(USER)?.title).toBe("Queued title"); expect(wizard.getActiveWizard(USER)?.step).toBe("prize");
  });

  it("recovers template and bug-report step transitions after delivery failures", async () => {
    for (const kind of ["template", "bug"] as const) {
      await h.start(kind); let failed = false;
      h.settings.fail = method => { if (method === "sendMessage" && !failed) { failed = true; return true; } return false; };
      await h.text("First input");
      expect(getWorkflow(USER)?.state).toMatchObject({ step: kind === "template" ? "name" : "description" });
      h.settings.fail = undefined; await h.text("Retried input");
      expect(getWorkflow(USER)?.state).toMatchObject({ step: kind === "template" ? "title" : "screenshot" });
    }
  });
  it("recovers a failed options screen after an image acknowledgement", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); await h.click("wiz_winners_1"); await h.click("wiz_time_none"); await h.click("wiz_opt_image");
    let failed = false;
    h.settings.fail = (method, p) => {
      if (!failed && method === "sendMessage" && p.reply_markup?.inline_keyboard?.flat().some((b: { text?: string }) => b.text === "✅ Create Raffle")) { failed = true; return true; }
      return false;
    };
    await h.photo(); expect(failed).toBe(true); expect(wizard.getActiveWizard(USER)?.imageFileId).toBe("uploaded");
    expect(h.button("wiz_opt_create")).toBeDefined();
  });
  it("session-bound scheduling, timezone, and template controls remain usable", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); await h.click("wiz_winners_1"); await h.click("wiz_time_none");
    await h.click("wiz_opt_sched"); await h.click("wsc:tz"); await h.click("wsc:tz:America/New_York"); await h.click("wsc:skip");
    expect(wizard.getActiveWizard(USER)?.scheduledTimezone).toBe("America/New_York");
    await h.start("template"); await h.text("Reusable"); await h.text("Title"); await h.text("Prize"); await h.click("twiz_winners_2"); await h.click("twiz_time_none");
    for (const token of getWorkflow(USER)!.controls.keys()) expect(Buffer.byteLength(token)).toBeLessThanOrEqual(64);
  });
  it("creates a template only once when its submit button is replayed", async () => {
    await h.start("template"); await h.text("Reusable"); await h.text("Title"); await h.text("Prize"); await h.click("twiz_winners_2"); await h.click("twiz_time_none");
    const submit = h.button("twiz_opt_create");
    await Promise.all([h.rawClick(submit.data, submit.messageId), h.rawClick(submit.data, submit.messageId)]);
    expect(db.getTemplatesForChat(GROUP)).toHaveLength(1); expect(Boolean(getWorkflow(USER))).toBe(false);
  });
  it("a delivered bug report is finished even if its success confirmation fails", async () => {
    const owner = 9999999; vi.stubEnv("BOT_OWNER_ID", String(owner));
    await h.start("bug"); await h.text("Description"); const submit = h.button("bugreport_skip");
    h.settings.fail = (method, p) => method === "sendMessage" && p.chat_id === USER && p.text.includes("Bug report sent");
    try { await h.rawClick(submit.data, submit.messageId); } catch {}
    expect(Boolean(getWorkflow(USER))).toBe(false);
    const delivered = h.calls.filter(call => call.method === "sendMessage" && call.payload.chat_id === owner).length;
    expect(delivered).toBeGreaterThan(0);
    await h.rawClick(submit.data, submit.messageId);
    expect(h.calls.filter(call => call.method === "sendMessage" && call.payload.chat_id === owner)).toHaveLength(delivered);
  });
  it("permission removal prevents an edit mutation and ends its workflow", async () => {
    const raffle = createRaffle(); await h.start("edit", USER, raffle.id); h.settings.memberStatus = "member";
    await h.click("edit_anon"); expect(db.getRaffleById(raffle.id)?.anonymous).toBe(0); expect(Boolean(getWorkflow(USER))).toBe(false);
  });
  it("a swallowed custom-winner prompt error restores the picker", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); let failed = false;
    h.settings.fail = (method, p) => { if (!failed && method === "sendMessage" && p.text.includes("Custom number of winners")) { failed = true; return true; } return false; };
    await h.click("wiz_winners_custom"); expect(failed).toBe(true); expect(wizard.getActiveWizard(USER)?.step).toBe("winners"); expect(h.button("wiz_winners_1")).toBeDefined();
  });
  it("recovers a step changed before Telegram rejects the callback acknowledgement", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize"); let failed = false;
    h.settings.fail = method => { if (method === "answerCallbackQuery" && !failed) { failed = true; return true; } return false; };
    await h.click("wiz_winners_7");
    expect(wizard.getActiveWizard(USER)?.step).toBe("winners"); expect(wizard.getActiveWizard(USER)?.maxWinners).toBeUndefined();
    expect(h.button("wiz_winners_1")).toBeDefined();
  });
  it("an unrelated message handler cannot replace the workflow prompt or refresh its timeout", async () => {
    await h.start("raffle"); await h.text("Title"); await h.text("Prize");
    const button = h.button("wiz_winners_1"); const then = getWorkflow(USER)!.state.createdAt;
    vi.setSystemTime(Date.now() + 1000); h.settings.interceptMessage = true;
    await h.text("Forwarded raffle");
    expect(h.button("wiz_winners_1")).toEqual(button); expect(getWorkflow(USER)!.state.createdAt).toBe(then);
  });
});
