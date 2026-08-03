import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateRaffleInput, RaffleTemplate } from "../src/types";

describe("recurring raffle post failures", () => {
  let db: typeof import("../src/database");
  let recurring: typeof import("../src/recurring");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    recurring = await import("../src/recurring");
  });

  function createActiveTemplate(): RaffleTemplate {
    const template = db.createTemplate({
      chat_id: -1001,
      thread_id: null,
      creator_id: 99,
      name: "Weekly",
      title: "Weekly Raffle",
      prize: "Prize",
      prizes: null,
      max_entries: null,
      max_winners: 1,
      duration_minutes: 60,
      sponsor_name: null,
      anonymous: 0,
      recurring_interval_minutes: 1440,
    });
    db.setRecurringActive(template.id, true, "2030-01-01 00:00:00");
    return db.getTemplateById(template.id)!;
  }

  function createRaffle(template: RaffleTemplate) {
    const input: CreateRaffleInput = {
      chat_id: template.chat_id,
      thread_id: 163,
      creator_id: template.creator_id,
      creator_name: "Recurring Raffle",
      title: template.title,
      description: "",
      prize: template.prize,
      prizes: null,
      max_entries: null,
      max_winners: 1,
      ends_at: null,
      starts_at: null,
      display_timezone: "UTC",
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
    };
    return db.createRaffle(input);
  }

  it("removes the failed raffle, pauses recurring, and notifies its creator", async () => {
    const template = createActiveTemplate();
    const raffle = createRaffle(template);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });

    const notified = await recurring.handleRecurringPostFailure(
      { sendMessage },
      template,
      raffle.id,
      "Raffles"
    );

    expect(notified).toBe(true);
    expect(db.getRaffleById(raffle.id)).toBeUndefined();
    expect(db.getTemplateById(template.id)).toMatchObject({
      recurring_active: 0,
      next_run_at: null,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      template.creator_id,
      expect.stringContaining("could not be posted to Raffles")
    );
  });

  it("still cleans up and pauses when the creator cannot be notified", async () => {
    const template = createActiveTemplate();
    const raffle = createRaffle(template);
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked"));

    const notified = await recurring.handleRecurringPostFailure(
      { sendMessage },
      template,
      raffle.id,
      "Raffles"
    );

    expect(notified).toBe(false);
    expect(db.getRaffleById(raffle.id)).toBeUndefined();
    expect(db.getTemplateById(template.id)?.recurring_active).toBe(0);
  });
});
