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
    filters: Array<{ column: string; value: unknown }>;
  }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import { getFellowshipThursdayRecords } from "@/app/(dashboard)/fellowship-thursday/page";

// ── Chainable Supabase mock ─────────────────────────────────────────────────

type QueryResult = { data?: unknown; error?: { message: string } | null };

function makeClient(responses: Record<string, QueryResult>) {
  return {
    from: (table: string) => {
      const record = {
        table,
        columns: "",
        filters: [] as Array<{ column: string; value: unknown }>,
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
          record.filters.push({ column, value });
          return builder;
        },
        in: (column, value) => {
          record.filters.push({ column, value });
          return builder;
        },
        then: (onFulfilled) =>
          Promise.resolve(responses[table] ?? { data: [], error: null }).then(onFulfilled),
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
  it("reads the effective view (never the raw base table) and uses effective values", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_fellowship_thursday: {
          data: [
            {
              attendance_id: 7,
              student_id: 42,
              attended: false,
              source_info: "HC",
              base_attended: true,
              base_source_info: "OCF",
              has_amendments: true,
            },
          ],
          error: null,
        },
        student: { data: [{ student_id: 42, full_name: "Ada Lovelace" }], error: null },
      })
    );

    const records = await getFellowshipThursdayRecords();

    // Operational read goes through the effective boundary, and the raw base
    // table is never touched.
    expect(queries.map((q) => q.table)).toContain("effective_fellowship_thursday");
    expect(queries.some((q) => q.table === "fellowship_thursday")).toBe(false);

    // The effective (newest corrected) value is what the page consumes, while
    // the base values remain available for the audit view.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      attendance_id: 7,
      attended: false,
      source_info: "HC",
      base_attended: true,
      base_source_info: "OCF",
      has_amendments: true,
      student: { full_name: "Ada Lovelace" },
    });
  });

  it("resolves student display names in a scoped lookup for the involved students", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_fellowship_thursday: {
          data: [
            { attendance_id: 2, student_id: 10, attended: true, source_info: null, base_attended: true, base_source_info: null, has_amendments: false },
            { attendance_id: 1, student_id: 11, attended: false, source_info: null, base_attended: false, base_source_info: null, has_amendments: false },
          ],
          error: null,
        },
        student: {
          data: [
            { student_id: 10, full_name: "Grace Hopper" },
            { student_id: 11, full_name: "Alan Turing" },
          ],
          error: null,
        },
      })
    );

    const records = await getFellowshipThursdayRecords();

    const studentQuery = queries.find((q) => q.table === "student");
    expect(studentQuery?.filters).toEqual([
      { column: "student_id", value: [10, 11] },
    ]);
    expect(records.map((r) => r.student?.full_name)).toEqual([
      "Grace Hopper",
      "Alan Turing",
    ]);
  });

  it("returns an empty list (never an exception) when the effective query errors", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_fellowship_thursday: { data: null, error: { message: "db unavailable" } },
      })
    );

    await expect(getFellowshipThursdayRecords()).resolves.toEqual([]);
  });
});
