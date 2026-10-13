/**
 * tests/unit/lib/audit/read.test.ts
 *
 * Audit read-model loader contract:
 *
 *   - every loader reads the explicit SAFE column projection (never `*`), so
 *     raw snapshot payloads (`old_values`/`new_values`) and Auth-binding ids
 *     never leave the database, and normalizes rows through the safe
 *     normalizer, returning `[]`/an empty page on any provider error (a broken
 *     read never crashes a detail page);
 *   - determinism: newest-first ordering by `occurred_at DESC` with an
 *     `audit_id DESC` tie-breaker so same-timestamp events keep a stable
 *     chronological order (R11/R12);
 *   - bound: history reads are server paginated (R10/NFR1). Each request is a
 *     single query capped by `ENTITY_HISTORY_PAGE_SIZE` (or a clamped explicit
 *     `limit`) and fetched with a `limit + 1` probe (`.range(0, limit)`), so
 *     detail pages and load-more clicks never pull unbounded history;
 *   - STABLE pagination: continuation is KEYSET (strictly older than the last
 *     returned `(occurred_at, audit_id)`) plus an optional high-watermark, so
 *     events inserted between pages can never be duplicated or skipped — the
 *     failure mode of offset-based "load more";
 *   - no N+1: a history read issues exactly one `from("audit_activity")` query
 *     and performs no per-row/related-entity lookups;
 *   - historical context (actor, timestamp, reason, entity label, allowlisted
 *     old→new changes) survives normalization;
 *   - `getStudentActivity` exposes the STUDENT UNIFIED SUBJECT TIMELINE:
 *     one combined timeline for a student by `subject_student_id` (events
 *     about the student from every entity context), not just the direct
 *     entity rows;
 *   - `getApplicationHistory([])` short-circuits without querying.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditHistoryCursor } from "@/lib/audit/history-api";
import type { AuditRow } from "@/lib/audit/presentation";

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServerClient }));

import {
  AUDIT_ACTIVITY_SAFE_COLUMNS,
  ENTITY_HISTORY_PAGE_SIZE,
  MAX_ENTITY_HISTORY_PAGE_SIZE,
  getApplicationHistory,
  getApplicationHistoryPage,
  getEntityHistory,
  getEntityHistoryPage,
  getStudentActivity,
  getStudentActivityPage,
} from "@/lib/audit/read";

type Row = Record<string, unknown>;

interface QueryRecord {
  select: string | null;
  filters: Array<{ op: "eq" | "in"; column: string; value: unknown }>;
  ors: string[];
  orders: Array<{ column: string; ascending: boolean }>;
  range: [number, number] | null;
}

interface FakeBuilder {
  select(columns: string): FakeBuilder;
  eq(column: string, value: unknown): FakeBuilder;
  in(column: string, value: unknown): FakeBuilder;
  or(expression: string): FakeBuilder;
  order(column: string, options: { ascending: boolean }): FakeBuilder;
  range(from: number, to: number): Promise<{ data: AuditRow[] | null; error: unknown }>;
}

function makeAuditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    action: "updated",
    actor_advisor_id: 5,
    actor_name_snapshot: "Jordan Lee",
    audit_id: 10,
    changes: null,
    entity_id: 3,
    entity_type: "student",
    fellowship_name: null,
    new_values: null,
    occurred_at: "2026-10-12T14:30:00.000Z",
    old_values: null,
    origin: "api",
    reason: "Reviewed",
    student_name: "Sam Student",
    subject_application_id: null,
    subject_fellowship_id: null,
    subject_student_id: 3,
    ...overrides,
  };
}

/** Compare scalars for the mini keyset engine (numbers numerically, else text). */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of expression) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function matchesSimple(row: Row, condition: string): boolean {
  const match = /^([a-z_]+)\.(eq|lt|lte|gt|gte)\.(.*)$/.exec(condition);
  if (!match) return false;
  const [, column, op, rawValue] = match;
  const value = rawValue.startsWith('"') && rawValue.endsWith('"')
    ? rawValue.slice(1, -1)
    : rawValue;
  const cell = row[column];
  const comparable = typeof cell === "number" ? Number(value) : value;
  switch (op) {
    case "eq":
      return String(cell) === String(comparable);
    case "lt":
      return compareValues(cell, comparable) < 0;
    case "lte":
      return compareValues(cell, comparable) <= 0;
    case "gt":
      return compareValues(cell, comparable) > 0;
    default:
      return compareValues(cell, comparable) >= 0;
  }
}

/** Evaluate one of the loader's generated `.or(...)` fragments against a row. */
function matchesOr(row: Row, expression: string): boolean {
  return splitTopLevel(expression).some((part) => {
    if (part.startsWith("and(") && part.endsWith(")")) {
      return splitTopLevel(part.slice(4, -1)).every((condition) => matchesSimple(row, condition));
    }
    return matchesSimple(row, part);
  });
}

/**
 * Minimal in-memory `audit_activity` engine: applies eq/in filters, the
 * generated keyset/watermark `.or(...)` bounds, multi-key ordering, and the
 * inclusive range probe. It reads `rows` by reference, so a test can "insert" a
 * new event between pages and observe the continuation behaviour.
 */
function makeDatasetClient(rows: AuditRow[], opts: { error?: unknown } = {}) {
  const calls: QueryRecord[] = [];
  const client = {
    from: vi.fn(() => {
      const record: QueryRecord = { select: null, filters: [], ors: [], orders: [], range: null };
      calls.push(record);

      const compute = (): AuditRow[] | null => {
        if (opts.error) return null;
        let result = rows.filter(
          (row) =>
            record.filters.every((filter) => {
              const cell = (row as unknown as Row)[filter.column];
              return filter.op === "eq"
                ? String(cell) === String(filter.value)
                : Array.isArray(filter.value) &&
                    (filter.value as unknown[]).some((value) => String(value) === String(cell));
            }) && record.ors.every((expression) => matchesOr(row as unknown as Row, expression))
        );
        // Stable multi-key ordering: apply tie-breakers first (reverse order).
        for (const order of [...record.orders].reverse()) {
          result = result.slice().sort((a, b) => {
            const comparison = compareValues(
              (a as unknown as Row)[order.column],
              (b as unknown as Row)[order.column]
            );
            return order.ascending ? comparison : -comparison;
          });
        }
        if (record.range) {
          const [from, to] = record.range;
          result = result.slice(from, to + 1);
        }
        return result;
      };

      const builder: FakeBuilder = {
        select(columns) {
          record.select = columns;
          return builder;
        },
        eq(column, value) {
          record.filters.push({ op: "eq", column, value });
          return builder;
        },
        in(column, value) {
          record.filters.push({ op: "in", column, value });
          return builder;
        },
        or(expression) {
          record.ors.push(expression);
          return builder;
        },
        order(column, options) {
          record.orders.push({ column, ...options });
          return builder;
        },
        range(from, to) {
          record.range = [from, to];
          return Promise.resolve({ data: compute(), error: opts.error ?? null });
        },
      };
      return builder;
    }),
  };
  createServerClient.mockReturnValue(client);
  return { client, calls };
}

/** Newest-first timeline: index 0 is the newest (highest audit_id/time). */
function makeTimeline(count: number, overrides: Partial<AuditRow> = {}, startId = 100): AuditRow[] {
  const base = Date.UTC(2026, 9, 12, 14, 30, 0);
  return Array.from({ length: count }, (_, index) =>
    makeAuditRow({
      audit_id: startId - index,
      occurred_at: new Date(base - index * 60_000).toISOString(),
      ...overrides,
    })
  );
}

function cursorOf(row: AuditRow): AuditHistoryCursor {
  return { occurredAt: row.occurred_at, auditId: row.audit_id };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("safe projection (no raw payload columns leave the database)", () => {
  it("selects ONLY the explicit safe columns for every loader", async () => {
    const { calls } = makeDatasetClient([makeAuditRow()]);

    await getEntityHistoryPage("advisor", 7);
    await getStudentActivityPage(3);
    await getApplicationHistoryPage([4]);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.select).toBe(AUDIT_ACTIVITY_SAFE_COLUMNS);
      expect(call.select).not.toContain("old_values");
      expect(call.select).not.toContain("new_values");
      expect(call.select).not.toContain("actor_advisor_id");
      expect(call.select).not.toContain("origin");
    }
  });
});

describe("getEntityHistory", () => {
  it("filters an entity context and orders newest-first with an audit_id tie-breaker", async () => {
    const { client, calls } = makeDatasetClient([
      makeAuditRow({ entity_type: "fellowship", entity_id: 12 }),
    ]);
    const result = await getEntityHistory("fellowship", 12);

    expect(client.from).toHaveBeenCalledWith("audit_activity");
    expect(calls[0].filters).toContainEqual({ op: "eq", column: "entity_type", value: "fellowship" });
    expect(calls[0].filters).toContainEqual({ op: "eq", column: "entity_id", value: 12 });
    expect(calls[0].orders).toEqual([
      { column: "occurred_at", ascending: false },
      { column: "audit_id", ascending: false },
    ]);
    expect(result[0]).toMatchObject({ id: "10", action: "updated", entityLabel: "fellowship: Sam Student" });
  });

  it("returns an empty timeline on a provider error (never crashes the page)", async () => {
    makeDatasetClient([], { error: { code: "PGRST116", message: "unreachable" } });
    await expect(getEntityHistory("student", 3)).resolves.toEqual([]);
  });

  it("never loads unbounded history: the query is capped to one server page", async () => {
    const { calls } = makeDatasetClient(makeTimeline(ENTITY_HISTORY_PAGE_SIZE + 40));
    const result = await getEntityHistory("student", 3);

    expect(calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);
    expect(result).toHaveLength(ENTITY_HISTORY_PAGE_SIZE);
  });
});

describe("getEntityHistoryPage (bounded keyset server pagination)", () => {
  it("fetches a limit+1 inclusive probe so `hasMore` is detected without a second query", async () => {
    const rows = makeTimeline(ENTITY_HISTORY_PAGE_SIZE + 1, { entity_type: "advisor", entity_id: 7 });
    const { client, calls } = makeDatasetClient(rows);

    const page = await getEntityHistoryPage("advisor", 7);

    expect(calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);
    expect(page.hasMore).toBe(true);
    // The probe row only signals `hasMore`; it is never surfaced.
    expect(page.items).toHaveLength(ENTITY_HISTORY_PAGE_SIZE);
    // Cursor points at the last SURFACED row; the watermark at the first row.
    expect(page.nextCursor).toEqual(cursorOf(rows[ENTITY_HISTORY_PAGE_SIZE - 1]));
    expect(page.highWatermark).toEqual(cursorOf(rows[0]));
    // No N+1: exactly one table query, one select, for the whole page.
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("reports the last page with `nextCursor: null` when no probe row is returned", async () => {
    const rows = makeTimeline(3, { entity_type: "advisor", entity_id: 7 });
    makeDatasetClient(rows);
    const page = await getEntityHistoryPage("advisor", 7);

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.highWatermark).toEqual(cursorOf(rows[0]));
    expect(page.items).toHaveLength(3);
  });

  it("emits a strictly-older keyset bound for a cursor (never an offset)", async () => {
    const { calls } = makeDatasetClient([]);
    const cursor = { occurredAt: "2026-10-12T14:30:00.000Z", auditId: 42 };

    await getEntityHistoryPage("student", 3, { limit: 10, cursor });

    expect(calls[0].range).toEqual([0, 10]);
    expect(calls[0].ors).toContain(
      'occurred_at.lt."2026-10-12T14:30:00.000Z",and(occurred_at.eq."2026-10-12T14:30:00.000Z",audit_id.lt.42)'
    );
  });

  it("pins continuation to the first page's high-watermark", async () => {
    const { calls } = makeDatasetClient([]);
    const highWatermark = { occurredAt: "2026-10-12T15:00:00.000Z", auditId: 99 };

    await getEntityHistoryPage("student", 3, { highWatermark });

    expect(calls[0].ors).toEqual([
      'occurred_at.lt."2026-10-12T15:00:00.000Z",and(occurred_at.eq."2026-10-12T15:00:00.000Z",audit_id.lte.99)',
    ]);
  });

  it("applies the watermark before the cursor so both bounds AND together", async () => {
    const { calls } = makeDatasetClient([]);
    await getEntityHistoryPage("student", 3, {
      cursor: { occurredAt: "2026-10-12T14:00:00.000Z", auditId: 10 },
      highWatermark: { occurredAt: "2026-10-12T15:00:00.000Z", auditId: 99 },
    });

    expect(calls[0].ors).toEqual([
      'occurred_at.lt."2026-10-12T15:00:00.000Z",and(occurred_at.eq."2026-10-12T15:00:00.000Z",audit_id.lte.99)',
      'occurred_at.lt."2026-10-12T14:00:00.000Z",and(occurred_at.eq."2026-10-12T14:00:00.000Z",audit_id.lt.10)',
    ]);
  });

  it("clamps unsafe limits instead of trusting the caller", async () => {
    const oversized = makeDatasetClient([]);
    await getEntityHistoryPage("student", 3, { limit: 5000 });
    expect(oversized.calls[0].range).toEqual([0, MAX_ENTITY_HISTORY_PAGE_SIZE]);

    const nonPositive = makeDatasetClient([]);
    await getEntityHistoryPage("student", 3, { limit: 0 });
    expect(nonPositive.calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);

    const nonFinite = makeDatasetClient([]);
    await getEntityHistoryPage("student", 3, { limit: Number.NaN });
    expect(nonFinite.calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);
  });

  it("returns an empty, non-advancing page on a provider error", async () => {
    makeDatasetClient([], { error: { message: "boom" } });
    await expect(getEntityHistoryPage("student", 3)).resolves.toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
      highWatermark: null,
    });
  });

  it("treats a null provider payload as an empty page for every loader", async () => {
    makeDatasetClient([], { error: { message: "boom" } });
    const empty = { items: [], hasMore: false, nextCursor: null, highWatermark: null } as const;
    await expect(getEntityHistoryPage("student", 3)).resolves.toEqual(empty);
    await expect(getStudentActivityPage(3)).resolves.toEqual(empty);
    await expect(getApplicationHistoryPage([3])).resolves.toEqual(empty);
  });

  it("preserves historical context (actor, timestamp, reason, label, old→new changes)", async () => {
    makeDatasetClient([
      makeAuditRow({
        actor_name_snapshot: "Jordan Lee",
        occurred_at: "2026-10-12T14:30:00.000Z",
        reason: "Corrected major",
        changes: { major: { old: "Biology", new: "Chemistry" } },
      }),
    ]);

    const { items } = await getEntityHistoryPage("student", 3);

    expect(items[0]).toMatchObject({
      id: "10",
      actor: "Jordan Lee",
      occurredAt: "2026-10-12T14:30:00.000Z",
      summary: "Corrected major",
      changes: [{ field: "major", label: "Major", oldValue: "Biology", newValue: "Chemistry" }],
    });
  });
});

describe("stable pagination across a mid-scroll insert", () => {
  it("never duplicates or skips rows when a new event is inserted between pages", async () => {
    const rows = makeTimeline(30);
    const { calls } = makeDatasetClient(rows);

    // Page 1: newest 25 rows.
    const first = await getEntityHistoryPage("student", 3);
    expect(first.items.map((item) => item.id)).toEqual(rows.slice(0, 25).map((row) => String(row.audit_id)));
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(cursorOf(rows[24]));

    // A brand-new event is recorded at the top of the log between pages.
    const inserted = makeAuditRow({
      audit_id: 999,
      occurred_at: new Date(Date.UTC(2026, 9, 12, 15, 0, 0)).toISOString(),
      student_name: "Sam Student",
    });
    rows.unshift(inserted);

    // Page 2 continues strictly older than the page-1 cursor, pinned to the
    // page-1 high-watermark.
    const second = await getEntityHistoryPage("student", 3, {
      cursor: first.nextCursor,
      highWatermark: first.highWatermark,
    });
    expect(second.items.map((item) => item.id)).toEqual(rows.slice(26).map((row) => String(row.audit_id)));
    expect(second.hasMore).toBe(false);
    expect(calls).toHaveLength(2);

    // No duplicate of the page-1 boundary row, no skipped older row, and the
    // newly inserted event never appears mid-scroll.
    const combined = [...first.items, ...second.items].map((item) => item.id);
    expect(combined).toEqual(rows.filter((row) => row.audit_id !== 999).map((row) => String(row.audit_id)));
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined).not.toContain("999");
  });

  it("would duplicate under plain offset paging — documents the failure the keyset fixes", async () => {
    // This is the counterfactual: an offset continuation after an insert
    // re-serves rows that were already shown. It proves the fixture is
    // meaningful, not that the loader uses offsets.
    const rows = makeTimeline(30);
    rows.unshift(makeAuditRow({ audit_id: 999, occurred_at: new Date(Date.UTC(2026, 9, 12, 15)).toISOString() }));
    const pageTwoByOffset = rows.slice(25, 50).map((row) => String(row.audit_id));
    expect(pageTwoByOffset).toContain(String(rows[25].audit_id));
  });
});

describe("getApplicationHistory", () => {
  it("filters by the subject application ids with the deterministic ordering", async () => {
    const { calls } = makeDatasetClient([makeAuditRow()]);
    await getApplicationHistory([4, 7]);

    expect(calls[0].filters).toContainEqual({ op: "in", column: "subject_application_id", value: [4, 7] });
    expect(calls[0].orders).toEqual([
      { column: "occurred_at", ascending: false },
      { column: "audit_id", ascending: false },
    ]);
  });

  it("short-circuits to an empty timeline WITHOUT querying for no application ids", async () => {
    const { client } = makeDatasetClient([]);
    await expect(getApplicationHistory([])).resolves.toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("short-circuits the bounded page too, still without querying", async () => {
    const { client } = makeDatasetClient([]);
    await expect(getApplicationHistoryPage([])).resolves.toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
      highWatermark: null,
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("bounds application history and returns an empty page on a provider error", async () => {
    const bounded = makeDatasetClient(
      makeTimeline(ENTITY_HISTORY_PAGE_SIZE + 2, { subject_application_id: 4 })
    );
    const page = await getApplicationHistoryPage([4, 7]);
    expect(bounded.calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);
    expect(page.items).toHaveLength(ENTITY_HISTORY_PAGE_SIZE);
    expect(page.hasMore).toBe(true);

    makeDatasetClient([], { error: { message: "boom" } });
    await expect(getApplicationHistoryPage([4, 7])).resolves.toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
      highWatermark: null,
    });
  });
});

describe("getStudentActivity (student unified subject timeline)", () => {
  it("queries the whole student SUBJECT timeline, not just direct entity rows", async () => {
    const { calls } = makeDatasetClient([makeAuditRow()]);
    await getStudentActivity(42);

    // The unified subject timeline key is `subject_student_id` — events about
    // the student from any entity context (application/fellowship/lifecycle).
    expect(calls[0].filters).toContainEqual({ op: "eq", column: "subject_student_id", value: 42 });
  });

  it("orders the student timeline newest-first with the audit_id tie-breaker", async () => {
    const { calls } = makeDatasetClient([makeAuditRow()]);
    await getStudentActivity(42);

    expect(calls[0].orders).toEqual([
      { column: "occurred_at", ascending: false },
      { column: "audit_id", ascending: false },
    ]);
  });

  it("normalizes rows and returns an empty timeline on error", async () => {
    makeDatasetClient([
      makeAuditRow({ audit_id: 1, action: "updated", reason: null, subject_student_id: 42 }),
      makeAuditRow({
        audit_id: 2,
        action: "voided",
        student_name: null,
        fellowship_name: "Freshman",
        subject_student_id: 42,
      }),
    ]);
    const result = await getStudentActivity(42);
    expect(result.map((entry) => entry.id)).toEqual(["2", "1"]);
    expect(result[0].entityLabel).toBe("student: Freshman");

    makeDatasetClient([], { error: { message: "boom" } });
    await expect(getStudentActivity(42)).resolves.toEqual([]);
  });

  it("bounds the unified timeline to one server page with a single query", async () => {
    const { client, calls } = makeDatasetClient(
      makeTimeline(ENTITY_HISTORY_PAGE_SIZE + 5, { subject_student_id: 42 })
    );
    const page = await getStudentActivityPage(42);

    expect(calls[0].range).toEqual([0, ENTITY_HISTORY_PAGE_SIZE]);
    expect(page.items).toHaveLength(ENTITY_HISTORY_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
