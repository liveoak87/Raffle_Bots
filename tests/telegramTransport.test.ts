import { afterEach, describe, expect, it, vi } from "vitest";
import { Api, Bot, HttpError } from "grammy";
import { createUpdateFetcher } from "@grammyjs/runner";
import { createGroupThrottle, createTelegramHealth, POLLING_OPTIONS, TELEGRAM_API_TIMEOUT_SECONDS, telegramRetry } from "../src/telegramTransport";

afterEach(() => vi.useRealTimers());

describe("Telegram outage recovery", () => {
  it("aborts a hung HTTP request at the client deadline", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const api = new Api("1234:offline", {
      timeoutSeconds: TELEGRAM_API_TIMEOUT_SECONDS,
      fetch: ((_url: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as any,
    });
    api.config.use(telegramRetry());
    const done = expect(api.getMe()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_001);
    await done;
    expect(aborted).toBe(true);
  });

  it("returns network failures to the job queue instead of retrying forever", async () => {
    vi.useFakeTimers();
    const failure = new HttpError("connection failed", new Error("offline"));
    const prev = vi.fn().mockRejectedValue(failure);
    await expect(telegramRetry()(prev, "sendMessage", { chat_id: 1, text: "test" })).rejects.toBe(failure);
    expect(prev).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the runner recover from 504s without losing the update offset", async () => {
    vi.useFakeTimers();
    const bot = new Bot("1234:offline");
    const requests: any[] = [];
    bot.api.config.use(async (_prev, _method, payload) => {
      requests.push({ ...payload });
      if (requests.length === 1) return { ok: false, error_code: 504, description: "Gateway Timeout" };
      return { ok: true, result: requests.length === 2 ? [{ update_id: 42 }] : [] };
    });
    bot.api.config.use(telegramRetry());
    const fetchUpdates = createUpdateFetcher(bot, { ...POLLING_OPTIONS, silent: true });
    const signal = new AbortController().signal;
    const batch = fetchUpdates(100, signal);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await batch).toEqual([{ update_id: 42 }]);
    await fetchUpdates(100, signal);
    expect(requests.map(r => r.offset)).toEqual([0, 0, 43]);
    expect(requests.some(r => r.drop_pending_updates)).toBe(false);
  });

  it("ends prolonged polling failure so the container can restart", async () => {
    vi.useFakeTimers();
    const bot = new Bot("1234:offline");
    bot.api.config.use(async () => ({ ok: false, error_code: 504, description: "Gateway Timeout" }));
    bot.api.config.use(telegramRetry());
    const fetchUpdates = createUpdateFetcher(bot, { ...POLLING_OPTIONS, silent: true });
    const result = expect(fetchUpdates(100, new AbortController().signal)).rejects.toMatchObject({ error_code: 504 });
    await vi.advanceTimersByTimeAsync(300_000);
    await result;
  });

  it("still respects Telegram's retry_after on outgoing rate limits", async () => {
    vi.useFakeTimers();
    const prev = vi.fn()
      .mockResolvedValueOnce({ ok: false, error_code: 429, description: "Too many requests", parameters: { retry_after: 2 } })
      .mockResolvedValue({ ok: true, result: true });
    const result = telegramRetry()(prev, "sendMessage", { chat_id: 1, text: "test" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(prev).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ ok: true, result: true });
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it("reports stale polling as unhealthy and recovers after a successful empty poll", () => {
    let time = 0;
    const health = createTelegramHealth(() => time);
    expect(health.isHealthy()).toBe(false);
    health.polling();
    expect(health.isHealthy()).toBe(false);
    health.pollSucceeded();
    expect(health.isHealthy()).toBe(true);
    time = 120_000;
    expect(health.isHealthy()).toBe(false);
    health.pollSucceeded();
    expect(health.isHealthy()).toBe(true);
    health.stopped();
    expect(health.isHealthy()).toBe(false);
  });
});

describe("group send limits", () => {
  it("allows a short burst, then waits for the oldest message to leave the minute window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = new Api("1234:offline");
    const calls: Array<{ method: string; chatId?: number; time: number }> = [];
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, chatId: (payload as { chat_id?: number }).chat_id, time: Date.now() });
      return { ok: true, result: true } as any;
    });
    api.config.use(createGroupThrottle().transform);
    const sends = Array.from({ length: 21 }, () => api.sendMessage(-100, "raffle"));
    await vi.advanceTimersByTimeAsync(21_000);
    expect(calls).toHaveLength(20);
    await api.answerCallbackQuery("click");
    await api.sendMessage(-200, "other group");
    expect(calls.slice(-2).map(call => call.time)).toEqual([21_000, 21_000]);
    await vi.advanceTimersByTimeAsync(38_999);
    expect(calls.filter(call => call.chatId === -100)).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(sends);
    expect(calls.at(-1)?.time).toBe(60_000);
  });
});
