import { describe, it, expect } from "vitest";
import {
  resolveTimezone,
  formatInTimezone,
  formatTimeOnlyInTimezone,
  buildUtcDateFromLocal,
  getNextNDates,
} from "../src/timezone";

describe("resolveTimezone", () => {
  it("accepts canonical IANA names", () => {
    expect(resolveTimezone("America/New_York")).toBe("America/New_York");
    expect(resolveTimezone("Europe/London")).toBe("Europe/London");
    expect(resolveTimezone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("UTC")).toBe("UTC");
  });

  it("maps common shortcuts to IANA", () => {
    expect(resolveTimezone("EST")).toBe("America/New_York");
    expect(resolveTimezone("est")).toBe("America/New_York");
    expect(resolveTimezone("Eastern")).toBe("America/New_York");
    expect(resolveTimezone("PST")).toBe("America/Los_Angeles");
    expect(resolveTimezone("Pacific")).toBe("America/Los_Angeles");
  });

  it("rejects garbage", () => {
    expect(resolveTimezone("")).toBeNull();
    expect(resolveTimezone("Mars/Olympus")).toBeNull();
    expect(resolveTimezone("not a timezone")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(resolveTimezone("  America/New_York  ")).toBe("America/New_York");
  });
});

describe("formatInTimezone", () => {
  it("formats UTC date in target timezone", () => {
    // 2026-06-15 18:00:00 UTC = 2026-06-15 14:00 EDT
    const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
    const result = formatInTimezone(date, "America/New_York");
    expect(result).toMatch(/2:00 PM EDT|2:00 PM GMT-4/);
  });

  it("uses 24h for UTC", () => {
    const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
    const result = formatInTimezone(date, "UTC");
    expect(result).toMatch(/18:00/);
  });

  it("includes day-of-week and month/day", () => {
    const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
    const result = formatInTimezone(date, "America/New_York");
    expect(result).toMatch(/Mon/);
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
  });

  it("falls back gracefully on invalid timezone", () => {
    const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
    const result = formatInTimezone(date, "Bogus/Tz");
    expect(result).toContain("UTC");
  });
});

describe("formatTimeOnlyInTimezone", () => {
  it("returns short time-only string", () => {
    const date = new Date(Date.UTC(2026, 5, 15, 18, 0, 0));
    const result = formatTimeOnlyInTimezone(date, "America/New_York");
    expect(result).toMatch(/2:00 PM/);
    expect(result).not.toMatch(/Mon|Jun|15/); // no date parts
  });
});

describe("buildUtcDateFromLocal", () => {
  it("converts a New York wall-clock time to UTC", () => {
    // 2026-06-15 14:00 EDT = 2026-06-15 18:00 UTC (UTC-4 in summer)
    const result = buildUtcDateFromLocal("2026-06-15", "14:00", "America/New_York");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-06-15T18:00:00.000Z");
  });

  it("handles DST correctly (winter EST = UTC-5)", () => {
    // 2026-01-15 14:00 EST = 2026-01-15 19:00 UTC (UTC-5 in winter)
    const result = buildUtcDateFromLocal("2026-01-15", "14:00", "America/New_York");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-01-15T19:00:00.000Z");
  });

  it("handles UTC (no shift)", () => {
    const result = buildUtcDateFromLocal("2026-06-15", "18:00", "UTC");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-06-15T18:00:00.000Z");
  });

  it("handles Tokyo (UTC+9, no DST)", () => {
    // 2026-06-15 14:00 JST = 2026-06-15 05:00 UTC
    const result = buildUtcDateFromLocal("2026-06-15", "14:00", "Asia/Tokyo");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-06-15T05:00:00.000Z");
  });

  it("rejects malformed date", () => {
    expect(buildUtcDateFromLocal("2026/06/15", "14:00", "UTC")).toBeNull();
    expect(buildUtcDateFromLocal("not-a-date", "14:00", "UTC")).toBeNull();
  });

  it("rejects malformed time", () => {
    expect(buildUtcDateFromLocal("2026-06-15", "14", "UTC")).toBeNull();
    expect(buildUtcDateFromLocal("2026-06-15", "25:00", "UTC")).toBeNull();
    expect(buildUtcDateFromLocal("2026-06-15", "14:60", "UTC")).toBeNull();
  });

  it("accepts single-digit hour", () => {
    const result = buildUtcDateFromLocal("2026-06-15", "9:00", "UTC");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  });
});

describe("getNextNDates", () => {
  it("returns the requested number of dates", () => {
    const result = getNextNDates("UTC", 7);
    expect(result.length).toBe(7);
  });

  it("returns dates in YYYY-MM-DD format", () => {
    const result = getNextNDates("UTC", 3);
    for (const d of result) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("first date is today in the target timezone", () => {
    const tz = "America/New_York";
    const result = getNextNDates(tz, 1);
    // Compare against what Intl says today is in NY
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(result[0]).toBe(today);
  });
});
