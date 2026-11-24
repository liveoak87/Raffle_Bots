import { describe, expect, it } from "vitest";
import { getTelegramApiRoot, getWebhookConfig } from "../src/config";

describe("getTelegramApiRoot", () => {
  it("preserves grammY's hosted API default unless a private origin is configured", () => {
    expect(getTelegramApiRoot({})).toBeUndefined();
    expect(getTelegramApiRoot({ TELEGRAM_API_ROOT: " http://raffle-telegram-api:8081/ " }))
      .toBe("http://raffle-telegram-api:8081");
  });

  it.each([
    "raffle-telegram-api:8081",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com/bot",
    "https://example.com/?key=value",
    "https://example.com/#fragment",
  ])("rejects an origin grammY cannot use safely: %s", (value) => {
    expect(() => getTelegramApiRoot({ TELEGRAM_API_ROOT: value })).toThrow(/HTTP or HTTPS origin/);
  });
});

describe("getWebhookConfig", () => {
  it("disables webhook mode when no URL is configured", () => {
    expect(getWebhookConfig({})).toBeNull();
  });

  it("requires an authenticated HTTPS /webhook endpoint", () => {
    expect(() => getWebhookConfig({ WEBHOOK_URL: "http://example.com/webhook" })).toThrow(/HTTPS/);
    expect(() => getWebhookConfig({ WEBHOOK_URL: "https://example.com/webhook" })).toThrow(/WEBHOOK_SECRET/);
    expect(() => getWebhookConfig({
      WEBHOOK_URL: "https://example.com/wrong",
      WEBHOOK_SECRET: "0123456789abcdef",
    })).toThrow(/\/webhook/);
  });

  it("returns a validated webhook configuration", () => {
    expect(getWebhookConfig({
      WEBHOOK_URL: "https://bot.example.com/webhook",
      WEBHOOK_SECRET: "0123456789abcdef_ABC",
      WEBHOOK_PORT: "3001",
    })).toEqual({
      url: "https://bot.example.com/webhook",
      secret: "0123456789abcdef_ABC",
      port: 3001,
    });
  });

  it("rejects malformed ports", () => {
    expect(() => getWebhookConfig({
      WEBHOOK_URL: "https://bot.example.com/webhook",
      WEBHOOK_SECRET: "0123456789abcdef",
      WEBHOOK_PORT: "NaN",
    })).toThrow(/WEBHOOK_PORT/);
  });
});
