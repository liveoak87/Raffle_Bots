import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateRaffleInput } from "../src/types";

describe("database optimization helpers", () => {
  let db: typeof import("../src/database");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
  });

  function raffleInput(overrides: Partial<CreateRaffleInput> = {}): CreateRaffleInput {
    return {
      chat_id: -1001,
      thread_id: null,
      creator_id: 10,
      creator_name: "Creator",
      title: "Test raffle",
      description: "",
      prize: "Prize",
      prizes: null,
      max_entries: null,
      max_winners: 1,
      ends_at: null,
      starts_at: null,
      display_timezone: null,
      required_chat_id: null,
      required_chat_title: null,
      sponsor_name: null,
      anonymous: 0,
      image_file_id: null,
      auto_pin: 0,
      min_account_age_days: 0,
      require_username: 0,
      winner_cooldown: 0,
      show_animation: 1,
      referral_enabled: 0,
      max_referral_entries: 0,
      revoke_referral_links: 0,
      ...overrides,
    };
  }

  it("stores and clears a default raffle topic without losing other defaults", () => {
    db.upsertGroupDefaults(-1001, {
      max_winners: 3,
      thread_id: 13803,
      thread_name: "Raffles",
    });
    expect(db.getGroupDefaults(-1001)).toMatchObject({
      max_winners: 3,
      thread_id: 13803,
      thread_name: "Raffles",
    });

    db.upsertGroupDefaults(-1001, { thread_id: null, thread_name: null });
    expect(db.getGroupDefaults(-1001)).toMatchObject({
      max_winners: 3,
      thread_id: null,
      thread_name: null,
    });
  });

  it("claimDueRecurringTemplates advances due rows once", () => {
    const template = db.createTemplate({
      chat_id: -1001,
      thread_id: null,
      creator_id: 10,
      name: "daily",
      title: "Daily",
      prize: "Prize",
      prizes: null,
      max_entries: null,
      max_winners: 1,
      duration_minutes: 60,
      sponsor_name: null,
      anonymous: 0,
      recurring_interval_minutes: 60,
    });

    db.setRecurringActive(template.id, true, "2000-01-01 00:00:00");

    const claimed = db.claimDueRecurringTemplates();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(template.id);

    const claimedAgain = db.claimDueRecurringTemplates();
    expect(claimedAgain).toHaveLength(0);

    const updated = db.getTemplateById(template.id);
    expect(updated?.next_run_at).not.toBe("2000-01-01 00:00:00");
  });

  it("getRecentEntriesForRaffle returns newest entries with referral bonuses", () => {
    const raffle = db.createRaffle(raffleInput({ referral_enabled: 1 }));
    db.addEntry(raffle.id, 1, "one", "One");
    db.addEntry(raffle.id, 2, "two", "Two");
    db.addEntry(raffle.id, 3, "three", "Three");

    const referral = db.createReferralLink(raffle.id, 3, "Three", raffle.chat_id, "https://t.me/+abc");
    db.incrementBonusEntries(referral.id);
    db.incrementBonusEntries(referral.id);

    const recent = db.getRecentEntriesForRaffle(raffle.id, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].user_id).toBe(3);
    expect(recent[0].bonus_entries).toBe(2);
    expect(recent[1].user_id).toBe(2);
    expect(recent[1].bonus_entries).toBe(0);
  });

  it("selectWinners handles referral weighting without duplicate winners", () => {
    const raffle = db.createRaffle(
      raffleInput({ referral_enabled: 1, max_winners: 3 })
    );
    db.addEntry(raffle.id, 1, "one", "One");
    db.addEntry(raffle.id, 2, "two", "Two");
    db.addEntry(raffle.id, 3, "three", "Three");
    const referral = db.createReferralLink(raffle.id, 1, "One", raffle.chat_id, "https://t.me/+one");
    db.incrementBonusEntries(referral.id);
    db.incrementBonusEntries(referral.id);

    const winners = db.selectWinners(raffle.id);
    expect(winners).toHaveLength(3);
    expect(new Set(winners.map((w) => w.user_id)).size).toBe(3);
  });

  it("remembers and removes verified admin groups per user", () => {
    db.upsertBotGroup(-1001, "Alpha", "administrator");
    db.upsertBotGroup(-1002, "Beta", "administrator");

    db.rememberUserAdminGroup(10, -1002);
    db.rememberUserAdminGroup(10, -1001);
    db.rememberUserAdminGroup(20, -1002);

    expect(db.getUserAdminGroups(10).map((group) => group.title)).toEqual([
      "Alpha",
      "Beta",
    ]);

    db.forgetUserAdminGroup(10, -1001);
    expect(db.getUserAdminGroups(10).map((group) => group.chat_id)).toEqual([
      -1002,
    ]);

    db.clearUserAdminGroups(10);
    expect(db.getUserAdminGroups(10)).toEqual([]);
    expect(db.getUserAdminGroups(20)).toHaveLength(1);
  });

  it("filters remembered groups using owner-controlled access settings", () => {
    db.upsertBotGroup(-1001, "Restricted", "administrator");
    db.rememberUserAdminGroup(10, -1001, "creator");
    db.rememberUserAdminGroup(20, -1001, "administrator");

    expect(db.getGroupAccessMode(-1001)).toBe("all_admins");
    expect(db.getUserAdminGroups(20)).toHaveLength(1);

    db.setGroupAccessMode(-1001, "owner_only");
    expect(db.getUserAdminGroups(10)).toHaveLength(1);
    expect(db.getUserAdminGroups(20)).toEqual([]);

    db.setGroupAccessMode(-1001, "selected_admins");
    expect(db.getUserAdminGroups(20)).toEqual([]);
    db.setSelectedGroupAdmin(-1001, 20, true, 10);
    expect(db.isSelectedGroupAdmin(-1001, 20)).toBe(true);
    expect(db.getSelectedGroupAdminIds(-1001)).toEqual([20]);
    expect(db.getUserAdminGroups(20)).toHaveLength(1);

    db.setSelectedGroupAdmin(-1001, 20, false, 10);
    expect(db.getUserAdminGroups(20)).toEqual([]);
  });

  it("lists a participant's open raffle entries across groups", () => {
    const first = db.createRaffle(raffleInput({ chat_id: -1001, title: "First" }));
    const second = db.createRaffle(raffleInput({ chat_id: -1002, title: "Second" }));
    const closed = db.createRaffle(raffleInput({ chat_id: -1003, title: "Closed" }));
    db.addEntry(first.id, 50, "person", "Person");
    db.addEntry(second.id, 50, "person", "Person");
    db.addEntry(closed.id, 50, "person", "Person");
    db.closeRaffle(closed.id);

    const entries = db.getOpenRafflesEnteredByUser(50);
    expect(entries.map((raffle) => raffle.title).sort()).toEqual(["First", "Second"]);
    expect(db.getOpenRafflesEnteredByUser(99)).toEqual([]);
  });
});
