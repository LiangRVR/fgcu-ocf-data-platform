import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/scholarship-history/scholarship-history-table", () => ({
  ScholarshipHistoryTable: () => null,
}));

const { createServerClient, queries } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  queries: [] as Array<{
    table: string;
    columns: string;
    filters: Array<{ column: string; value: unknown; op: "eq" | "in" }>;
  }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import {
  getScholarshipHistory,
  summarizeOperationalAwards,
} from "@/app/(dashboard)/scholarship-history/page";

type QueryResult = { data?: unknown; error?: { message: string } | null };

function makeClient(responses: Record<string, QueryResult>) {
  return {
    from: (table: string) => {
      const record = {
        table,
        columns: "",
        filters: [] as Array<{ column: string; value: unknown; op: "eq" | "in" }>,
      };
      queries.push(record);

      const builder: {
        select: (columns: string) => typeof builder;
        order: () => typeof builder;
        eq: (column: string, value: unknown) => typeof builder;
        in: (column: string, value: unknown) => typeof builder;
        then: (onFulfilled: (value: QueryResult) => unknown) => Promise<unknown>;
      } = {
        select: (columns) => {
          record.columns = columns;
          return builder;
        },
        order: () => builder,
        eq: (column, value) => {
          record.filters.push({ column, value, op: "eq" });
          return builder;
        },
        in: (column, value) => {
          record.filters.push({ column, value, op: "in" });
          return builder;
        },
        then: (onFulfilled) =>
          Promise.resolve(responses[table] ?? { data: [], error: null }).then(onFulfilled),
      };
      return builder;
    },
  };
}

const activeRecord = {
  history_id: 5,
  student_id: 20,
  fellowship_id: 99, // corrected effective program
  base_fellowship_id: 7,
  has_correction: true,
  is_voided: false,
  void_amendment_id: null,
  voided_at: null,
  voided_by_advisor_id: null,
};

const voidedRecord = {
  history_id: 6,
  student_id: 20,
  fellowship_id: 7,
  base_fellowship_id: 7,
  has_correction: false,
  is_voided: true,
  void_amendment_id: 44,
  voided_at: "2026-10-01T00:00:00.000Z",
  voided_by_advisor_id: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
});

describe("getScholarshipHistory", () => {
  it("reads the effective view (with correctable void state) and uses the corrected award program", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_scholarship_history: { data: [activeRecord, voidedRecord], error: null },
        student: { data: [{ student_id: 20, full_name: "Katherine Johnson" }], error: null },
        fellowship: { data: [{ fellowship_id: 99, fellowship_name: "Corrected Program" }], error: null },
      })
    );

    const records = await getScholarshipHistory();

    // Operational reads use the effective boundary, never the raw base table.
    expect(queries.some((q) => q.table === "effective_scholarship_history")).toBe(true);
    expect(queries.some((q) => q.table === "scholarship_history")).toBe(false);

    // The audit surface must retain voided awards so their amendment trail
    // stays reachable; the effective view is not filtered to non-voided rows.
    const effectiveQuery = queries.find((q) => q.table === "effective_scholarship_history");
    expect(effectiveQuery?.filters.some((f) => f.column === "is_voided")).toBe(false);

    // The corrected fellowship (not the immutable base value) drives display,
    // and the void state is preserved for the audit presentation.
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      history_id: 5,
      fellowship_id: 99,
      base_fellowship_id: 7,
      is_voided: false,
      student: { full_name: "Katherine Johnson" },
      fellowship: { fellowship_name: "Corrected Program" },
    });
    expect(records[1]).toMatchObject({ history_id: 6, is_voided: true });
  });

  it("returns an empty list (never an exception) when the effective query errors", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_scholarship_history: { data: null, error: { message: "db unavailable" } },
      })
    );

    await expect(getScholarshipHistory()).resolves.toEqual([]);
  });
});

describe("summarizeOperationalAwards", () => {
  it("excludes voided awards from the operational counts", () => {
    const records = [
      activeRecord,
      voidedRecord,
    ] as unknown as Parameters<typeof summarizeOperationalAwards>[0];

    expect(summarizeOperationalAwards(records)).toEqual({
      records: 1,
      students: 1,
      repeatAwards: 0,
    });
  });
});
