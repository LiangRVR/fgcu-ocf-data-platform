/**
 * tests/unit/lib/utils/new-york-date.test.ts
 *
 * Strict, DST-corrected America/New_York (OCF office) calendar-date helper:
 * validation, inclusive lower / exclusive upper UTC instants, leap dates, and
 * the 23-hour (spring-forward) and 25-hour (fall-back) local days.
 */
import { describe, expect, it } from "vitest";
import {
  getNewYorkMonthRange,
  percentageOf,
  isValidNewYorkDate,
  newYorkLocalMidnightInstant,
  newYorkNextLocalMidnightInstant,
  resolveNewYorkDateRange,
} from "@/lib/utils/new-york-date";

describe("getNewYorkMonthRange", () => {
  it("uses the OCF month rather than the server/UTC month at a boundary", () => {
    // Still October 31 in New York, already November 1 in UTC.
    expect(getNewYorkMonthRange(new Date("2026-11-01T03:30:00.000Z"))).toMatchObject({
      start: "2026-10-01",
      endExclusive: "2026-11-01",
      label: "October 2026",
    });
  });

  it("rolls December into the following year", () => {
    expect(getNewYorkMonthRange(new Date("2026-12-15T12:00:00.000Z"))).toMatchObject({
      start: "2026-12-01",
      endExclusive: "2027-01-01",
    });
  });
});

describe("percentageOf", () => {
  it.each([
    [0, 0, 0],
    [3, 0, 0],
    [3, 3, 100],
    [4, 1, 25],
    [3, 12, 100],
  ])("handles total=%i portion=%i", (total, portion, expected) => {
    expect(percentageOf(total, portion)).toBe(expected);
  });
});

describe("isValidNewYorkDate", () => {
  it("accepts strict Gregorian dates including leap days", () => {
    expect(isValidNewYorkDate("2026-10-15")).toBe(true);
    expect(isValidNewYorkDate("2028-02-29")).toBe(true);
  });

  it("rejects malformed, out-of-range, and non-leap dates", () => {
    for (const value of ["", "2026-2-3", "2026/10/15", "abc", "2026-13-01", "2026-00-10", "2027-02-29"]) {
      expect(isValidNewYorkDate(value), value).toBe(false);
    }
  });
});

describe("New York local midnight instants", () => {
  it("maps an ordinary EDT day to a 04:00Z lower and 04:00Z upper boundary", () => {
    expect(newYorkLocalMidnightInstant("2026-10-15").toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(newYorkNextLocalMidnightInstant("2026-10-15").toISOString()).toBe("2026-10-16T04:00:00.000Z");
  });

  it("handles the 23-hour spring-forward day (2026-03-08)", () => {
    const start = newYorkLocalMidnightInstant("2026-03-08").getTime();
    const end = newYorkNextLocalMidnightInstant("2026-03-08").getTime();
    expect(new Date(start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(end - start).toBe(23 * 60 * 60 * 1000);
  });

  it("handles the 25-hour fall-back day (2026-11-01)", () => {
    const start = newYorkLocalMidnightInstant("2026-11-01").getTime();
    const end = newYorkNextLocalMidnightInstant("2026-11-01").getTime();
    expect(new Date(start).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(end - start).toBe(25 * 60 * 60 * 1000);
  });

  it("keeps a late-evening NY instant on the correct calendar day", () => {
    // 2026-10-15 23:30 America/New_York is 2026-10-16T03:30Z; the filter's
    // exclusive upper bound (2026-10-16T04:00Z) still contains it.
    const instant = new Date("2026-10-16T03:30:00.000Z").getTime();
    const upper = newYorkNextLocalMidnightInstant("2026-10-15").getTime();
    expect(instant).toBeLessThan(upper);
  });
});

describe("resolveNewYorkDateRange", () => {
  it("returns inclusive lower / exclusive upper UTC instants", () => {
    expect(resolveNewYorkDateRange("2026-10-15", "2026-10-15")).toEqual({
      from: "2026-10-15",
      through: "2026-10-15",
      fromInstant: "2026-10-15T04:00:00.000Z",
      throughExclusiveInstant: "2026-10-16T04:00:00.000Z",
    });
  });

  it("drops malformed bounds", () => {
    expect(resolveNewYorkDateRange("nope", "2026-10-10")).toMatchObject({
      from: undefined,
      through: "2026-10-10",
      fromInstant: undefined,
      throughExclusiveInstant: "2026-10-11T04:00:00.000Z",
    });
  });

  it("canonicalizes a reversed range by dropping the invalid upper bound", () => {
    expect(resolveNewYorkDateRange("2026-10-20", "2026-10-10")).toMatchObject({
      from: "2026-10-20",
      through: undefined,
      throughExclusiveInstant: undefined,
    });
  });

  it("returns an empty range for absent input", () => {
    expect(resolveNewYorkDateRange(undefined, undefined)).toEqual({
      from: undefined,
      through: undefined,
      fromInstant: undefined,
      throughExclusiveInstant: undefined,
    });
  });
});
