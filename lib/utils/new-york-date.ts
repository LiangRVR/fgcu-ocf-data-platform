/**
 * Strict, DST-corrected `America/New_York` (OCF office) calendar-date helper.
 *
 * Activity date-only filters are OCF-office calendar days: the lower bound is
 * the instant of local midnight for the `from` date (inclusive) and the upper
 * bound is the instant of local midnight for the day AFTER `through`
 * (exclusive). Because the IANA zone is used through `Intl.DateTimeFormat`
 * (full ICU), a 23-hour (spring forward) or 25-hour (fall back) day is handled
 * by the platform rather than a fixed UTC offset — no arithmetic offset is
 * ever assumed.
 *
 * The helper is PURE and non-visual: it validates strict Gregorian
 * `YYYY-MM-DD` input, returns `undefined` for anything malformed, and
 * canonicalizes a reversed `from > through` range by dropping the invalid
 * upper bound. Display formatting of timestamps stays browser-local and is a
 * separate concern (see `formatAuditDate`).
 */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const NEW_YORK = "America/New_York";

export interface NewYorkMonthRange {
  /** OCF calendar-date lower bound, inclusive. */
  start: string;
  /** First day of the following OCF month, exclusive. */
  endExclusive: string;
  /** Human-facing OCF reporting label. */
  label: string;
}

/**
 * Derive an OCF reporting month without depending on the server's local zone.
 * Meeting dates are date-only values, so callers use the returned calendar
 * bounds directly rather than converting them through UTC instants.
 */
export function getNewYorkMonthRange(now: Date = new Date()): NewYorkMonthRange {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const next = new Date(Date.UTC(year, month, 1));
  return {
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    endExclusive: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`,
    label: new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK, month: "long", year: "numeric" }).format(now),
  };
}

/** Safe percentage for two counts drawn from the same reporting period. */
export function percentageOf(total: number, portion: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(portion) || total <= 0 || portion <= 0) return 0;
  return Math.min(100, Math.round((portion / total) * 100));
}

/** Strict Gregorian calendar-date validation (`YYYY-MM-DD`). */
export function isValidNewYorkDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** The zone's UTC offset (ms east of UTC) at a given instant. */
function zoneOffsetMs(timeZone: string, instant: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

/** The UTC instant of local midnight for a strict `YYYY-MM-DD` date. */
export function newYorkLocalMidnightInstant(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = wallClockAsUtc - zoneOffsetMs(NEW_YORK, new Date(wallClockAsUtc));
  // Re-resolve once so a DST boundary between the guess and the instant is
  // corrected (second iteration is idempotent for a real IANA zone).
  instant = wallClockAsUtc - zoneOffsetMs(NEW_YORK, new Date(instant));
  return new Date(instant);
}

/** The UTC instant of local midnight for the day AFTER a strict date. */
export function newYorkNextLocalMidnightInstant(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day));
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(
    next.getUTCDate()
  ).padStart(2, "0")}`;
  return newYorkLocalMidnightInstant(nextDate);
}

export interface NewYorkDateRange {
  /** Canonical lower `YYYY-MM-DD` bound (inclusive), or undefined when invalid. */
  from?: string;
  /** Canonical upper `YYYY-MM-DD` bound (inclusive day), or undefined when invalid. */
  through?: string;
  /** UTC instant of the inclusive lower local midnight. */
  fromInstant?: string;
  /** UTC instant of the exclusive upper local midnight (day after `through`). */
  throughExclusiveInstant?: string;
}

/**
 * Validate and canonicalize an OCF-office date range. Malformed values are
 * dropped; a reversed `from > through` range drops the invalid upper bound so
 * the caller can redirect to a canonical URL.
 */
export function resolveNewYorkDateRange(
  fromValue?: string,
  throughValue?: string
): NewYorkDateRange {
  const from = fromValue && isValidNewYorkDate(fromValue) ? fromValue : undefined;
  let through = throughValue && isValidNewYorkDate(throughValue) ? throughValue : undefined;
  if (from && through && from > through) through = undefined;
  return {
    from,
    through,
    fromInstant: from ? newYorkLocalMidnightInstant(from).toISOString() : undefined,
    throughExclusiveInstant: through
      ? newYorkNextLocalMidnightInstant(through).toISOString()
      : undefined,
  };
}
