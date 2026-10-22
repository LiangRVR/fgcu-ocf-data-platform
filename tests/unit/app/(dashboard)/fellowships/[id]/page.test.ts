import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { getScholarshipHistory } from "@/app/(dashboard)/fellowships/[id]/page";

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

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
});

describe("fellowship detail scholarship history reader", () => {
  it("reads the effective view filtered by effective program, excluding voids", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_scholarship_history: {
          data: [
            {
              history_id: 21,
              student_id: 77,
              fellowship_id: 12,
              base_fellowship_id: 4,
              has_correction: true,
              is_voided: false,
              void_amendment_id: null,
              voided_at: null,
              voided_by_advisor_id: null,
            },
          ],
          error: null,
        },
        student: { data: [{ student_id: 77, full_name: "Dorothy Vaughan" }], error: null },
      })
    );

    const records = await getScholarshipHistory(12);

    expect(queries.some((q) => q.table === "effective_scholarship_history")).toBe(true);
    expect(queries.some((q) => q.table === "scholarship_history")).toBe(false);
    const effectiveQuery = queries.find((q) => q.table === "effective_scholarship_history");
    expect(effectiveQuery?.filters).toContainEqual({ column: "fellowship_id", value: 12, op: "eq" });
    expect(effectiveQuery?.filters).toContainEqual({ column: "is_voided", value: false, op: "eq" });
    expect(records[0]).toMatchObject({
      history_id: 21,
      fellowship_id: 12,
      student: { student_id: 77, full_name: "Dorothy Vaughan" },
    });
  });
});
