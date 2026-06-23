import { describe, it, expect } from "vitest";
import { buildCalendar, previousMonth, nextMonth, ymdToYearMonth } from "../src/calendar";

describe("buildCalendar", () => {
  it("returns nav + weekday header + day rows", () => {
    const cal = buildCalendar(2026, 5, "2026-05-15");
    expect(cal.year).toBe(2026);
    expect(cal.month).toBe(5);
    expect(cal.rows[0][1].kind).toBe("nav-title");
    expect((cal.rows[0][1] as { kind: "nav-title"; label: string }).label).toBe("May 2026");
    expect(cal.rows[1].every((c) => c.kind === "weekday-header")).toBe(true);
  });

  it("pads the first row before day 1", () => {
    // May 2026 starts on a Friday (dow=5), so first row should have 5 empty + Fri + Sat
    const cal = buildCalendar(2026, 5, "2026-05-15");
    const firstDayRow = cal.rows[2];
    expect(firstDayRow.length).toBe(7);
    expect(firstDayRow.filter((c) => c.kind === "empty").length).toBe(5);
    const firstDay = firstDayRow.find((c) => c.kind === "day");
    expect(firstDay).toBeDefined();
    expect((firstDay as { kind: "day"; date: string }).date).toBe("2026-05-01");
  });

  it("marks days in the past correctly", () => {
    const cal = buildCalendar(2026, 5, "2026-05-15");
    let pastCount = 0;
    let futureCount = 0;
    for (const row of cal.rows) {
      for (const cell of row) {
        if (cell.kind === "day") {
          if (cell.inPast) pastCount++;
          else futureCount++;
        }
      }
    }
    // Days 1-14 are past (14 days), today 15 + 16-31 are not past (17 days)
    expect(pastCount).toBe(14);
    expect(futureCount).toBe(17);
  });

  it("marks today distinctly", () => {
    const cal = buildCalendar(2026, 5, "2026-05-15");
    const todays = cal.rows.flat().filter((c) => c.kind === "day" && c.today);
    expect(todays.length).toBe(1);
    expect((todays[0] as { kind: "day"; date: string }).date).toBe("2026-05-15");
  });

  it("disables back nav when at current month", () => {
    const cal = buildCalendar(2026, 5, "2026-05-15");
    expect(cal.rows[0][0].kind).toBe("empty"); // back arrow suppressed
  });

  it("enables back nav when viewing future month", () => {
    const cal = buildCalendar(2026, 7, "2026-05-15");
    expect(cal.rows[0][0].kind).toBe("nav-prev");
  });

  it("disables forward nav past maxMonthsForward", () => {
    const cal = buildCalendar(2027, 5, "2026-05-15", 12);
    // 12 months forward from May 2026 = May 2027 exactly — at the boundary, forward should be off
    expect(cal.rows[0][2].kind).toBe("empty");
  });

  it("handles February in a leap year", () => {
    const cal = buildCalendar(2024, 2, "2024-02-15");
    const days = cal.rows
      .flat()
      .filter((c) => c.kind === "day")
      .length;
    expect(days).toBe(29);
  });

  it("handles February in a non-leap year", () => {
    const cal = buildCalendar(2026, 2, "2026-02-15");
    const days = cal.rows
      .flat()
      .filter((c) => c.kind === "day")
      .length;
    expect(days).toBe(28);
  });
});

describe("previousMonth / nextMonth", () => {
  it("rolls back from January", () => {
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
  });

  it("rolls forward from December", () => {
    expect(nextMonth(2026, 12)).toEqual({ year: 2027, month: 1 });
  });

  it("standard middle-month moves", () => {
    expect(previousMonth(2026, 7)).toEqual({ year: 2026, month: 6 });
    expect(nextMonth(2026, 7)).toEqual({ year: 2026, month: 8 });
  });
});

describe("ymdToYearMonth", () => {
  it("parses YYYY-MM-DD", () => {
    expect(ymdToYearMonth("2026-05-15")).toEqual({ year: 2026, month: 5 });
  });
});
