import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleError } from "../src/schedule";
import * as db from "../src/database";
import * as wizard from "../src/wizard";
import { createRaffle, workflowHarness, GROUP, USER } from "./workflowHarness";
import { expireWorkflows, WORKFLOW_TIMEOUT_MS } from "../src/workflowSessions";
vi.mock("../src/banners", () => ({ sendRafflePost: vi.fn(async () => 999), sendCustomImage: vi.fn() }));
describe("scheduled raffle windows", () => {
 beforeEach(() => { vi.useFakeTimers({toFake:["Date"]}); db.initDatabase(":memory:"); db.upsertBotGroup(GROUP,"Audit Group","administrator"); });
 afterEach(async () => { vi.setSystemTime(Date.now()+WORKFLOW_TIMEOUT_MS+1); await expireWorkflows(); db.getDb().close(); vi.useRealTimers(); });
 it("accepts untimed raffles and valid delayed windows", () => {
   expect(scheduleError(null,"2030-01-01 10:00:00")).toBeNull();
   expect(scheduleError("2030-01-01 11:00:00","2030-01-01 10:00:00")).toBeNull();
 });
 it("rejects malformed, equal, and reversed time windows", () => {
   expect(scheduleError("invalid",null)).toBeTruthy();
   expect(scheduleError("2030-01-01 10:00:00","2030-01-01 10:00:00")).toBeTruthy();
   expect(scheduleError("2030-01-01 09:00:00","2030-01-01 10:00:00")).toBeTruthy();
 });
 it("prevents an edit from closing the raffle before its start", () => {
   const r=createRaffle();
   db.updateRaffleFields(r.id,{ends_at:"2030-01-01 11:00:00",starts_at:"2030-01-01 10:00:00"});
   expect(()=>db.updateRaffleFields(r.id,{ends_at:"2030-01-01 09:00:00"})).toThrow(/closing time/);
   expect(db.getRaffleById(r.id)?.ends_at).toBe("2030-01-01 11:00:00");
 });
 it("keeps the wizard open with actionable feedback instead of publishing an invalid window", async () => {
   const h=workflowHarness(); await h.text("/newraffle",USER,GROUP); await h.text("Audit"); await h.text("Prize");
   await h.click("wiz_winners_1"); await h.click("wiz_time_none");
   const state=wizard.getActiveWizard(USER)!; state.startsAt="2030-01-01 10:00:00";state.endsAt="2030-01-01 09:00:00";
   await h.click("wiz_opt_create");
   expect(db.getOpenRafflesForChat(GROUP)).toHaveLength(0);
   expect(wizard.getActiveWizard(USER)).toBeDefined();
   expect(h.calls.some(c=>String(c.payload.text).includes("closing time must be after"))).toBe(true);
 });
});
