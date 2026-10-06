import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy client/server component graph; only the exported loaders are
// exercised here.
vi.mock("@/components/advising/advising-table", () => ({ AdvisingHistory: () => null }));
vi.mock("@/components/students/student-info-editor", () => ({ StudentInfoEditor: () => null }));

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
  getFellowshipThursday,
  getScholarshipHistory,
} from "@/app/(dashboard)/students/[id]/page";

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

describe("student detail operational readers", () => {
  it("reads student Fellowship Thursday values from the effective view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_fellowship_thursday: {
          data: [
            {
              attendance_id: 3,
              student_id: 55,
              attended: false,
              source_info: null,
              base_attended: true,
              base_source_info: "OCF",
              has_amendments: true,
            },
          ],
          error: null,
        },
      })
    );

    const records = await getFellowshipThursday(55);

    expect(queries.map((q) => q.table)).toContain("effective_fellowship_thursday");
    expect(queries.some((q) => q.table === "fellowship_thursday")).toBe(false);
    expect(records[0]).toMatchObject({ attendance_id: 3, attended: false, source_info: null });
  });

  it("reads student Scholarship History from the effective view, excluding voids and using the corrected fellowship", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        effective_scholarship_history: {
          data: [
            {
              history_id: 8,
              student_id: 55,
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
        fellowship: { data: [{ fellowship_id: 12, fellowship_name: "Effective Program" }], error: null },
      })
    );

    const records = await getScholarshipHistory(55);

    expect(queries.some((q) => q.table === "effective_scholarship_history")).toBe(true);
    expect(queries.some((q) => q.table === "scholarship_history")).toBe(false);
    const effectiveQuery = queries.find((q) => q.table === "effective_scholarship_history");
    expect(effectiveQuery?.filters).toContainEqual({ column: "student_id", value: 55, op: "eq" });
    expect(effectiveQuery?.filters).toContainEqual({ column: "is_voided", value: false, op: "eq" });
    expect(records[0]).toMatchObject({
      history_id: 8,
      fellowship_id: 12,
      fellowship: { fellowship_name: "Effective Program" },
    });
  });
});
