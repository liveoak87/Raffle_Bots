/**
 * Timezone utilities.
 *
 * Times in the database are always stored as UTC (in SQLite TEXT, "YYYY-MM-DD HH:MM:SS" format,
 * without a trailing 'Z' but interpreted as UTC by every reader).
 *
 * For display and user input we convert to/from the chat's configured timezone.
 * The chat's timezone is set per-group via `/timezone <IANA name>`.
 *
 * IANA timezones (e.g. "America/New_York") are supported natively by Node.js
 * via `Intl.DateTimeFormat`. We also accept common shortcut names (EST, PST,
 * etc.) and map them to IANA equivalents.
 */

/**
 * Common shortcut → IANA mapping. NOT a substitute for proper IANA names —
 * just convenience for users who say "EST" when they mean "America/New_York".
 *
 * Note: EST/EDT etc. are technically *not* timezones (they're offsets). Using
 * the IANA name handles DST correctly, which is what users actually want.
 */
const TZ_SHORTCUTS: Record<string, string> = {
  UTC: "UTC",
  GMT: "UTC",
  EST: "America/New_York",
  EDT: "America/New_York",
  ET: "America/New_York",
  EASTERN: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  CT: "America/Chicago",
  CENTRAL: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  MT: "America/Denver",
  MOUNTAIN: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  PT: "America/Los_Angeles",
  PACIFIC: "America/Los_Angeles",
  HST: "Pacific/Honolulu",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
};

/**
 * Resolve a user-supplied timezone string to a canonical IANA name.
 * Returns null if the timezone is invalid or unrecognized.
 */
export function resolveTimezone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try shortcut first (case-insensitive)
  const upper = trimmed.toUpperCase();
  if (TZ_SHORTCUTS[upper]) return TZ_SHORTCUTS[upper];

  // Validate as a real IANA timezone by asking Intl
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Format a UTC Date in the given timezone.
 * Returns e.g. "Mon May 12, 6:00 PM EDT" or "Mon May 12, 18:00 UTC".
 */
export function formatInTimezone(utcDate: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: timezone !== "UTC", // UTC reads naturally as 24h
      timeZoneName: "short",
    });
    return fmt.format(utcDate);
  } catch {
    // Fallback if timezone is somehow invalid at format time
    return utcDate.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

/**
 * Format a UTC Date as a short time-only string in the given timezone.
 * Returns e.g. "6:00 PM EDT".
 */
export function formatTimeOnlyInTimezone(utcDate: Date, timezone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: timezone !== "UTC",
      timeZoneName: "short",
    });
    return fmt.format(utcDate);
  } catch {
    return utcDate.toISOString().slice(11, 16) + " UTC";
  }
}

/**
 * Build a UTC Date from a "wall clock" date/time string interpreted in the given timezone.
 *
 * Example: buildUtcDateFromLocal("2026-12-31", "18:00", "America/New_York")
 *   returns the UTC Date corresponding to 6 PM EST/EDT in New York.
 *
 * Returns null if the date or time strings can't be parsed.
 */
export function buildUtcDateFromLocal(
  dateStr: string,
  timeStr: string,
  timezone: string
): Date | null {
  // Validate inputs
  const dateMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const [, y, mo, d] = dateMatch;
  const [, h, mi] = timeMatch;
  const year = parseInt(y, 10);
  const month = parseInt(mo, 10);
  const day = parseInt(d, 10);
  const hour = parseInt(h, 10);
  const minute = parseInt(mi, 10);

  if (
    year < 2000 || year > 2100 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    return null;
  }

  // Trick: format a known UTC time in the target timezone, compute the
  // offset, then reverse-apply it. This handles DST correctly because we're
  // asking Intl what offset applies on the *target* day.
  return findUtcForLocal(year, month, day, hour, minute, timezone);
}

/**
 * Given a "wall clock" date in a target timezone, find the UTC Date that
 * renders to that wall clock when formatted in the timezone.
 *
 * Implementation note: there's no clean Node API for "treat this as local
 * time in TZ X, give me UTC." We binary-search by formatting candidate UTC
 * times in the target timezone until we hit the desired wall clock. Two
 * iterations are enough because the offset is constant within a day except
 * at DST transitions.
 */
function findUtcForLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date | null {
  // Start by guessing the offset is 0 (UTC) and refining
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let iter = 0; iter < 3; iter++) {
    const wall = getWallClockParts(candidate, timezone);
    if (!wall) return null;
    const dh = hour - wall.hour;
    const dm = minute - wall.minute;
    const dd = day - wall.day;
    const dmo = month - wall.month;
    const dy = year - wall.year;
    if (dh === 0 && dm === 0 && dd === 0 && dmo === 0 && dy === 0) return candidate;
    // Shift by the observed difference
    const offsetMs =
      dy * 365 * 86_400_000 +
      dmo * 30 * 86_400_000 +
      dd * 86_400_000 +
      dh * 3_600_000 +
      dm * 60_000;
    candidate = new Date(candidate.getTime() + offsetMs);
  }
  return candidate;
}

function getWallClockParts(
  utcDate: Date,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts: Record<string, number> = {};
    for (const part of fmt.formatToParts(utcDate)) {
      if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute") {
        parts[part.type] = parseInt(part.value, 10);
      }
    }
    // Intl can return hour "24" for midnight in some locales — normalize
    if (parts.hour === 24) parts.hour = 0;
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
    };
  } catch {
    return null;
  }
}

/**
 * Helper for the wizard: given a chat's timezone, return the next N calendar
 * dates as "YYYY-MM-DD" strings starting from "today" in that timezone.
 */
export function getNextNDates(timezone: string, count: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const future = new Date(now.getTime() + i * 86_400_000);
    const parts = getWallClockParts(future, timezone);
    if (!parts) continue;
    const m = String(parts.month).padStart(2, "0");
    const d = String(parts.day).padStart(2, "0");
    out.push(`${parts.year}-${m}-${d}`);
  }
  return out;
}
