import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  escapeCsvCell,
  parseEndTime,
  formatCountdown,
  getBackupDirectory,
} from "../src/helpers";

describe("escapeHtml", () => {
  it("escapes <, >, and &", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes nested HTML payloads", () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });

  it("preserves plain text", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("emojis 🎉 work")).toBe("emojis 🎉 work");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("parseEndTime", () => {
  it("parses minute durations", () => {
    const before = Date.now();
    const result = parseEndTime("30m");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(30 * 60 * 1000 - 100);
    expect(diff).toBeLessThanOrEqual(30 * 60 * 1000 + 100);
  });

  it("parses hour durations", () => {
    const before = Date.now();
    const result = parseEndTime("2h");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 100);
    expect(diff).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 100);
  });

  it("parses day durations", () => {
    const before = Date.now();
    const result = parseEndTime("7d");
    expect(result).not.toBeNull();
    const diff = result!.getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 100);
    expect(diff).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 100);
  });

  it("accepts unit variations", () => {
    expect(parseEndTime("45 min")).not.toBeNull();
    expect(parseEndTime("3 hours")).not.toBeNull();
    expect(parseEndTime("1 day")).not.toBeNull();
  });

  it("rejects garbage input", () => {
    expect(parseEndTime("hello")).toBeNull();
    expect(parseEndTime("")).toBeNull();
    expect(parseEndTime("30x")).toBeNull();
  });

  it("rejects zero and overflowing relative durations", () => {
    expect(parseEndTime("0m")).toBeNull();
    expect(parseEndTime("999999999999999999999999d")).toBeNull();
  });

  it("rejects times in the past", () => {
    // Yesterday — should be rejected because raffles can't end in the past
    expect(parseEndTime("2020-01-01")).toBeNull();
  });
});

describe("escapeCsvCell", () => {
  it("escapes quotes and neutralizes spreadsheet formulas", () => {
    expect(escapeCsvCell('A "quoted" name')).toBe('"A ""quoted"" name"');
    expect(escapeCsvCell("=HYPERLINK(\"https://evil.test\")")).toBe(
      '"\'=HYPERLINK(""https://evil.test"")"'
    );
  });
});

describe("getBackupDirectory", () => {
  it("places backups beside the configured database", () => {
    expect(getBackupDirectory("/data/raffle.db")).toBe("/data/backups");
  });
});

describe("formatCountdown", () => {
  it("returns 'Ended' for past dates", () => {
    expect(formatCountdown(new Date(Date.now() - 1000))).toBe("Ended");
  });

  it("formats seconds when under a minute", () => {
    const target = new Date(Date.now() + 30_000);
    const result = formatCountdown(target);
    expect(result).toMatch(/^\d+s remaining$/);
  });

  it("includes days for far-future targets", () => {
    const target = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const result = formatCountdown(target);
    expect(result).toMatch(/3d/);
  });
});
