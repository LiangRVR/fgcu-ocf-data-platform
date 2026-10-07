import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
//
// The page loader is the unit under test; the client table component is
// irrelevant here, so it is stubbed to keep the module graph narrow.

vi.mock("@/components/fellowship-thursday/fellowship-thursday-table", () => ({
  FellowshipThursdayTable: () => null,
}));

const { createServerClient, queries } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  queries: [] as Array<{
    table: string;
    columns: string;
    filters: Array<{ column: string; op: "eq" | "ilike"; value: unknown }>;
    orders: Array<{ column: string; ascending: boolean }>;
    range: { from: number; to: number } | null;
  }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import { getFellowshipThursdayRecords } from "@/app/(dashboard)/fellowship-thursday/page";

// ── Chainable Supabase mock ─────────────────────────────────────────────────

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};
type QueryRecord = (typeof queries)[number];

function makeClient(responses: Record<string, QueryResult>) {
  return {
    from: (table: string) => {
      const record: QueryRecord = {
        table,
        columns: "",
        filters: [],
        orders: [],
        range: null,
      };
      queries.push(record);

      const builder = {
        select: (columns: string) => {
          record.columns = columns;
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          record.orders.push({ column, ascending: options?.ascending ?? true });
          return builder;
        },
        eq: (column: string, value: unknown) => {
          record.filters.push({ column, op: "eq", value });
          return builder;
        },
        ilike: (column: string, value: unknown) => {
          record.filters.push({ column, op: "ilike", value });
          return builder;
        },
        in: (column: string, value: unknown) => {
          record.filters.push({ column, op: "eq", value });
          return builder;
        },
        range: (from: number, to: number) => {
          record.range = { from, to };
          return builder;
        },
        then: (onFulfilled: (value: QueryResult) => unknown) =>
          Promise.resolve(responses[table] ?? { data: [], error: null }).then(
            onFulfilled
          ),
      };
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
});

describe("getFellowshipThursdayRecords", () => {
  it("reads the effective list view with exact count, inclusive range, and stable ID order", async () => {
    const row = {
      attendance_id: 7,
      student_id: 42,
      attended: false,
      source_info: "HC",
      base_attended: true,
      base_source_info: "OCF",
      has_amendments: true,
      student_name: "Ada Lovelace",
    };

    createServerClient.mockReturnValue(
      makeClient({
        fellowship_thursday_list: { data: [row], error: null, count: 42 },
      })
    );

    const result = await getFellowshipThursdayRecords({ page: "2", pageSize: "50" });

    // The operational read goes through the effective list boundary, never the
    // raw base table, and the range/count are exact.
    const query = queries.find((q) => q.table === "fellowship_thursday_list");
    expect(query?.columns).toBe("*");
    expect(query?.orders).toEqual([{ column: "attendance_id", ascending: false }]);
    expect(query?.range).toEqual({ from: 50, to: 99 });
    expect(queries.some((q) => q.table === "fellowship_thursday")).toBe(false);

    expect(result).toEqual({
      records: [{ ...row, student: { full_name: "Ada Lovelace" } }],
      count: 42,
      pagination: { page: 2, pageSize: 50, offset: 50, to: 99 },
      pages: 1,
      error: null,
    });
  });

  it("applies search/source/attended as server-side filters on the list view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        fellowship_thursday_list: { data: [], error: null, count: 0 },
      })
    );

    await getFellowshipThursdayRecords({ search: "ada", source: "HC", attended: "no" });

    const query = queries.find((q) => q.table === "fellowship_thursday_list");
    expect(query?.filters).toEqual([
      { column: "student_name", op: "ilike", value: "%ada%" },
      { column: "source_info", op: "eq", value: "HC" },
      { column: "attended", op: "eq", value: false },
    ]);
  });

  it("keeps the normal list query bounded and avoids loading student selector data", async () => {
    createServerClient.mockReturnValue(makeClient({ fellowship_thursday_list: { data: [], error: null, count: 0 } }));
    await getFellowshipThursdayRecords();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ table: "fellowship_thursday_list", columns: "*", range: { from: 0, to: 24 } });
    expect(queries[0].orders).toEqual([{ column: "attendance_id", ascending: false }]);
  });

  it("returns an empty, errored result (never throws) when the query fails", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        fellowship_thursday_list: {
          data: null,
          error: { message: "db unavailable" },
          count: null,
        },
      })
    );

    const result = await getFellowshipThursdayRecords();

    expect(result.records).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.pages).toBe(0);
    expect(result.error?.message).toBe("db unavailable");
  });
});
