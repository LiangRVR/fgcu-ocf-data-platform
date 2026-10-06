import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/students/students-table", () => ({ StudentsTable: () => null }));

const { createServerClient, queries } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  queries: [] as Array<{ table: string; columns: string }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import { getExceptionIds } from "@/app/(dashboard)/students/page";

type QueryResult = { data?: unknown; error?: { message: string } | null };

function makeClient(responses: Record<string, QueryResult>) {
  return {
    from: (table: string) => {
      const record = { table, columns: "" };
      queries.push(record);

      const builder: {
        select: (columns: string) => typeof builder;
        then: (onFulfilled: (value: QueryResult) => unknown) => Promise<unknown>;
      } = {
        select: (columns) => {
          record.columns = columns;
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

describe("getExceptionIds", () => {
  it("derives prior-award membership from the effective view and excludes voided awards", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        application: { data: [{ student_id: 1 }], error: null },
        advising_meeting: { data: [{ student_id: 2 }], error: null },
        effective_scholarship_history: {
          data: [
            { student_id: 3, is_voided: false },
            { student_id: 4, is_voided: true },
            { student_id: 3, is_voided: false },
          ],
          error: null,
        },
      })
    );

    const ids = await getExceptionIds();

    expect(queries.some((q) => q.table === "effective_scholarship_history")).toBe(true);
    expect(queries.some((q) => q.table === "scholarship_history")).toBe(false);
    const historyQuery = queries.find((q) => q.table === "effective_scholarship_history");
    expect(historyQuery?.columns).toContain("is_voided");

    expect([...ids.withHistory].sort()).toEqual([3]);
    expect([...ids.withApps]).toEqual([1]);
    expect([...ids.withMeetings]).toEqual([2]);
  });
});
