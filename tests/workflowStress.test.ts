import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/database";
import * as wizard from "../src/wizard";
import { expireWorkflows, getWorkflow, WORKFLOW_TIMEOUT_MS } from "../src/workflowSessions";
import { workflowHarness, createRaffle, GROUP } from "./workflowHarness";

vi.mock("../src/banners", () => ({ sendRafflePost: vi.fn(async () => 999), sendCustomImage: vi.fn() }));

describe("workflow concurrency and failure stress", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    db.initDatabase(":memory:");
    db.upsertBotGroup(GROUP, "Stress Group", "administrator");
  });
  afterEach(async () => {
    vi.setSystemTime(Date.now() + WORKFLOW_TIMEOUT_MS + 1);
    await expireWorkflows(); db.getDb().close(); vi.useRealTimers();
  });

  it("500 concurrent creators: 5,500 updates with duplicate controls create exactly 500 raffles", async () => {
    const h = workflowHarness();
    const users = Array.from({ length: 500 }, (_, i) => 8900000000 + i);
    h.settings.delay = async () => { await Promise.resolve(); };
    await Promise.all(users.flatMap(user => [
      h.text("/newraffle", user, GROUP), h.text(`Raffle ${user}`, user), h.text(`Prize ${user}`, user),
    ]));
    for (const user of users) {
      expect(wizard.getActiveWizard(user)?.title).toBe(`Raffle ${user}`);
      expect(wizard.getActiveWizard(user)?.prizes).toEqual([`Prize ${user}`]);
    }
    await Promise.all(users.map(async (user, i) => {
      const count = (i % 10) + 1;
      const button = h.button(`wiz_winners_${count}`, user);
      await Promise.all(Array.from({ length: 4 }, () => h.rawClick(button.data, button.messageId, user)));
      expect(wizard.getActiveWizard(user)?.maxWinners).toBe(count);
      await h.click("wiz_time_none", user);
      const create = h.button("wiz_opt_create", user);
      await Promise.all(Array.from({ length: 3 }, () => h.rawClick(create.data, create.messageId, user)));
      expect(Boolean(getWorkflow(user))).toBe(false);
    }));
    const raffles = db.getOpenRafflesForChat(GROUP);
    expect(raffles).toHaveLength(500);
    expect(new Set(raffles.map(raffle => raffle.creator_id)).size).toBe(500);
    for (const raffle of raffles) {
      expect(raffle.title).toBe(`Raffle ${raffle.creator_id}`);
      expect(raffle.prize).toBe(`Prize ${raffle.creator_id}`);
    }
    const sent = new Map(h.calls.filter(call => call.method === "sendMessage").map(call => [call.messageId, call]));
    for (const deletion of h.calls.filter(call => call.method === "deleteMessages")) {
      for (const id of deletion.payload.message_ids) {
        expect(sent.get(id)?.payload.chat_id).toBe(deletion.payload.chat_id);
        expect(sent.get(id)?.payload.text).not.toContain("has been posted");
      }
    }
    console.log(JSON.stringify({ scenario: "concurrent_creation", users: 500, updates: 5500, raffles: raffles.length, api_calls: h.calls.length }));
  }, 30_000);

  it("300 users switch workflows 2,400 times with delivery failures and batch expiry", async () => {
    const h = workflowHarness();
    const users = Array.from({ length: 300 }, (_, i) => 9000000000 + i);
    const original = new Map(users.map(user => [user, createRaffle(user).id]));
    const failed = new Set<number>();
    h.settings.fail = (method, payload) => {
      if (method === "sendMessage" && payload.text.includes("Step 2 of 4") && payload.chat_id % 7 === 0 && !failed.has(payload.chat_id)) {
        failed.add(payload.chat_id); return true;
      }
      return method === "deleteMessages" && payload.chat_id % 11 === 0;
    };
    const kinds = ["edit", "template", "bug", "raffle", "edit", "template", "bug", "raffle"] as const;
    for (const kind of kinds) {
      await Promise.all(users.map(async user => {
        await h.start(kind, user, original.get(user));
        expect(getWorkflow(user)?.kind).toBe(kind);
        if (kind === "edit") await h.click("edit_title", user);
        if (kind === "template") { await h.text(`Template ${user}`, user); await h.text("Title", user); await h.text("Prize", user); }
        if (kind === "bug") await h.text(`Description ${user}`, user);
        if (kind === "raffle") {
          await h.text(`Title ${user}`, user);
          if (wizard.getActiveWizard(user)?.step === "title") await h.text(`Title ${user}`, user);
          expect(wizard.getActiveWizard(user)?.title).toBe(`Title ${user}`);
        }
      }));
    }
    expect(failed.size).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + WORKFLOW_TIMEOUT_MS);
    await expireWorkflows();
    for (const user of users) {
      expect(Boolean(getWorkflow(user))).toBe(false);
      expect(db.getRaffleById(original.get(user)!)?.title).toBe("Original");
    }
    expect(db.getOpenRafflesForChat(GROUP)).toHaveLength(300);
    expect(db.getTemplatesForChat(GROUP)).toHaveLength(0);
    console.log(JSON.stringify({ scenario: "switch_failure_expiry", users: 300, replacements: 2400, injected_prompt_failures: failed.size, api_calls: h.calls.length }));
  }, 30_000);
});
