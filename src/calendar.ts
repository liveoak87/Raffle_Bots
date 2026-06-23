/**
 * Pure logic for rendering a Telegram inline-keyboard calendar.
 *
 * Returns the structured layout (rows of cells) so the wizard code can
 * map cells to InlineKeyboard buttons with the right callback data.
 *
 * Each cell is one of:
 *   - { kind: "day", date: "YYYY-MM-DD", label: "1"–"31", inPast: boolean, today: boolean }
 *   - { kind: "empty" } — padding cell before the 1st of the month
 *   - { kind: "nav-prev" | "nav-next" | "nav-title", label, payload? }
 *   - { kind: "weekday-header", label }
 *
 * Pure, deterministic, depends only on inputs — easy to test.
 */

export type CalendarCell =
  | { kind: "day"; date: string; label: string; inPast: boolean; today: boolean }
  | { kind: "empty" }
  | { kind: "nav-prev"; label: string; toYear: number; toMonth: number }
  | { kind: "nav-next"; label: string; toYear: number; toMonth: number }
  | { kind: "nav-title"; label: string }
  | { kind: "weekday-header"; label: string };

export interface CalendarGrid {
  year: number;
  month: number; // 1-12
  rows: CalendarCell[][]; // grid rows, including header rows
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Build a calendar grid for the given month, marking past dates and today
 * based on the user's current "wall clock" (in their timezone).
 *
 * @param year     Display year (e.g. 2026)
 * @param month    Display month (1-12)
 * @param todayYmd "YYYY-MM-DD" representing today in the user's timezone
 * @param maxMonthsForward How far into the future the user can navigate (default 12)
 */
export function buildCalendar(
  year: number,
  month: number,
  todayYmd: string,
  maxMonthsForward = 12
): CalendarGrid {
  const rows: CalendarCell[][] = [];

  // Nav header row
  const prev = previousMonth(year, month);
  const next = nextMonth(year, month);

  // Compute today's year/month for "can we go back?"
  const [ty, tm] = todayYmd.split("-").map(Number);
  const canGoBack = year > ty || (year === ty && month > tm);
  const canGoForward = monthsBetween(ty, tm, year, month) < maxMonthsForward;

  const navRow: CalendarCell[] = [];
  if (canGoBack) {
    navRow.push({
      kind: "nav-prev",
      label: "‹",
      toYear: prev.year,
      toMonth: prev.month,
    });
  } else {
    navRow.push({ kind: "empty" });
  }
  navRow.push({ kind: "nav-title", label: `${MONTH_NAMES[month - 1]} ${year}` });
  if (canGoForward) {
    navRow.push({
      kind: "nav-next",
      label: "›",
      toYear: next.year,
      toMonth: next.month,
    });
  } else {
    navRow.push({ kind: "empty" });
  }
  rows.push(navRow);

  // Weekday header row
  rows.push(WEEKDAY_LABELS.map((l) => ({ kind: "weekday-header" as const, label: l })));

  // Days
  const daysInMonth = new Date(year, month, 0).getDate(); // month is 1-12, this gives last day
  // What day-of-week does day 1 fall on? (0=Sunday)
  const firstDow = new Date(year, month - 1, 1).getDay();

  let row: CalendarCell[] = [];
  // Pad before day 1
  for (let i = 0; i < firstDow; i++) {
    row.push({ kind: "empty" });
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const inPast = dateStr < todayYmd;
    const today = dateStr === todayYmd;
    row.push({
      kind: "day",
      date: dateStr,
      label: today ? `·${day}·` : String(day),
      inPast,
      today,
    });
    if (row.length === 7) {
      rows.push(row);
      row = [];
    }
  }
  // Pad final row
  while (row.length > 0 && row.length < 7) {
    row.push({ kind: "empty" });
  }
  if (row.length === 7) rows.push(row);

  return { year, month, rows };
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

export function nextMonth(year: number, month: number): { year: number; month: number } {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function monthsBetween(y1: number, m1: number, y2: number, m2: number): number {
  return (y2 - y1) * 12 + (m2 - m1);
}

/** Get year/month from "YYYY-MM-DD". */
export function ymdToYearMonth(ymd: string): { year: number; month: number } {
  const [y, m] = ymd.split("-").map(Number);
  return { year: y, month: m };
}
