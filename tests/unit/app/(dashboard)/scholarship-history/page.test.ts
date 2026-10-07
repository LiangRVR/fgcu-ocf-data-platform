import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/scholarship-history/scholarship-history-table", () => ({
  ScholarshipHistoryTable: () => null,
}));

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import {
  getScholarshipHistory,
  normalizeFellowshipFilter,
  summarizeOperationalAwards,
} from "@/app/(dashboard)/scholarship-history/page";

// ── Chainable Supabase mock ─────────────────────────────────────────────────

type QueryResult = { data?: unknown; error?: { message: string } | null; count?: number | null };

interface QueryRecord {
  table: string;
  columns?: string;
  filters: Array<{ column: string; op: string; value: unknown }>;
  orders: Array<{ column: string; ascending: boolean }>;
  range?: [number, number];
  rpcArgs?: Record<string, unknown>;
}

/**
 * Build a Supabase-like client whose per-call result is resolved by `handler`.
 * The handler receives the recorded query shape so tests can assert the exact
 * predicate/order/range and route the list vs. aggregate vs. amendment call.
 */
function makeClient(handler: (record: QueryRecord) => QueryResult) {
  const calls: QueryRecord[] = [];
  const client = {
    calls,
    from: (table: string) => {
      const record: QueryRecord = { table, filters: [], orders: [] };
      calls.push(record);
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        if (name === "select") record.columns = args[0] as string;
        else if (name === "eq" || name === "ilike") {
          record.filters.push({ column: args[0] as string, op: name, value: args[1] });
        } else if (name === "in") {
          record.filters.push({ column: args[0] as string, op: "in", value: args[1] });
        } else if (name === "order") {
          record.orders.push({
            column: args[0] as string,
            ascending: (args[1] as { ascending?: boolean } | undefined)?.ascending ?? true,
          });
        } else if (name === "range") {
          record.range = [args[0] as number, args[1] as number];
        }
        return builder;
      };
      for (const method of ["select", "eq", "ilike", "in", "order", "range", "is", "not"]) {
        builder[method] = chain(method);
      }
      builder.then = (resolve: (value: QueryResult) => unknown) =>
        Promise.resolve(handler(record)).then(resolve);
      return builder;
    },
    // The operational summary is a single RLS-preserving aggregate RPC, never an
    // unbounded row projection.
    rpc: (fn: string, args?: Record<string, unknown>) => {
      const record: QueryRecord = { table: `rpc:${fn}`, filters: [], orders: [], rpcArgs: args };
      calls.push(record);
      return Promise.resolve(handler(record));
    },
  };
  return client;
}

const activeRecord = {
  history_id: 5,
  student_id: 20,
  fellowship_id: 99, // corrected effective program
  base_fellowship_id: 7,
  has_correction: true,
  is_voided: false,
  voided_at: null,
  student_name: "Katherine Johnson",
  fellowship_name: "Corrected Program",
};

const voidedRecord = {
  history_id: 6,
  student_id: 20,
  fellowship_id: 7,
  base_fellowship_id: 7,
  has_correction: false,
  is_voided: true,
  voided_at: "2026-10-01T00:00:00.000Z",
  student_name: "Katherine Johnson",
  fellowship_name: "Original Program",
};

type Client = ReturnType<typeof makeClient>;

function route(
  responses: {
    list?: QueryResult;
    operational?: QueryResult;
    amendments?: QueryResult;
  },
) {
  return (record: QueryRecord): QueryResult => {
    if (record.table === "rpc:scholarship_history_operational_summary") {
      return (
        responses.operational ?? {
          data: [{ total_records: 0, distinct_students: 0 }],
          error: null,
        }
      );
    }
    if (record.table === "scholarship_history_list") {
      return responses.list ?? { data: [], error: null, count: 0 };
    }
    if (record.table === "scholarship_history_amendment") {
      return responses.amendments ?? { data: [], error: null };
    }
    return { data: [], error: null };
  };
}

function listQueries(client: Client): QueryRecord[] {
  return client.calls.filter((call) => call.table === "scholarship_history_list");
}

function operationalQuery(client: Client): QueryRecord | undefined {
  return client.calls.find(
    (call) => call.table === "rpc:scholarship_history_operational_summary",
  );
}

function pageQuery(client: Client): QueryRecord | undefined {
  return listQueries(client).find((call) => call.columns === "*");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getScholarshipHistory", () => {
  it("reads the paginated list view with exact count, history_id DESC and range", async () => {
    const client = makeClient(
      route({
        list: { data: [activeRecord, voidedRecord], error: null, count: 2 },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory();

    // The flattened SECURITY INVOKER view is the only award source; the raw
    // base table is never read.
    expect(client.calls.some((q) => q.table === "scholarship_history")).toBe(false);
    // Normal browsing must not load selector tables: students and fellowships
    // are resolved on demand (and only inside the creation/correction controls),
    // never as a side effect of rendering the paginated list.
    expect(
      client.calls.some((q) => q.table === "student" || q.table === "fellowship"),
      "normal browsing avoids selector tables",
    ).toBe(false);
    const page = pageQuery(client);
    expect(page?.columns).toBe("*");
    expect(page?.orders).toEqual([{ column: "history_id", ascending: false }]);
    expect(page?.range).toEqual([0, 24]);

    expect(result.count).toBe(2);
    expect(result.pages).toBe(1);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      history_id: 5,
      fellowship_id: 99,
      base_fellowship_id: 7,
      is_voided: false,
      student: { full_name: "Katherine Johnson" },
      fellowship: { fellowship_name: "Corrected Program" },
      effective: { history_id: 5 },
    });
    expect(result.records[1]).toMatchObject({ history_id: 6, is_voided: true });
    expect(result.error).toBeNull();
  });

  it("loads amendment trails in one bounded query for exactly the page IDs", async () => {
    const client = makeClient(
      route({
        list: { data: [activeRecord, voidedRecord], error: null, count: 2 },
        amendments: {
          data: [
            { amendment_id: 44, history_id: 6, amendment_type: "Void", reason: "voided", corrected_fellowship_id: null, created_at: "2026-10-01T00:00:00.000Z", created_by_advisor_id: 2, details: null, fellowship: null },
            { amendment_id: 45, history_id: 5, amendment_type: "Correction", reason: "fixed", corrected_fellowship_id: 99, created_at: "2026-10-02T00:00:00.000Z", created_by_advisor_id: 2, details: null, fellowship: { fellowship_name: "Corrected Program" } },
          ],
          error: null,
        },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory();

    const amendmentQuery = client.calls.find((q) => q.table === "scholarship_history_amendment");
    expect(amendmentQuery?.filters).toContainEqual({ column: "history_id", op: "in", value: [5, 6] });
    expect(amendmentQuery?.orders).toEqual([
      { column: "created_at", ascending: true },
      { column: "amendment_id", ascending: true },
    ]);
    expect(result.records[0].amendments).toHaveLength(1);
    expect(result.records[0].amendments[0]).toMatchObject({ amendment_id: 45 });
    expect(result.records[1].amendments[0]).toMatchObject({ amendment_id: 44 });
  });

  it("derives a non-void operational summary independently of the page slice via the aggregate RPC", async () => {
    const client = makeClient(
      route({
        // The page contains a single row, but the operational relation spans
        // several rows across the whole filtered dataset.
        list: { data: [activeRecord], error: null, count: 100 },
        operational: {
          data: [{ total_records: 3, distinct_students: 2 }],
          error: null,
        },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory({ page: "4", pageSize: "25" });

    const operational = operationalQuery(client);
    // One RLS-preserving aggregate call carries no row payload, page range, or
    // filter builder: the database scopes it to the whole filtered relation.
    expect(operational).toBeDefined();
    expect(operational?.range).toBeUndefined();
    expect(operational?.rpcArgs).toEqual({ p_search: null, p_fellowship_id: null });
    // The former unbounded `student_id` projection must be gone entirely.
    expect(
      listQueries(client).some((call) => call.columns === "student_id"),
      "no unbounded student_id projection",
    ).toBe(false);

    expect(result.count).toBe(100); // list pagination count (includes voids)
    expect(result.summary).toEqual({ records: 3, students: 2, repeatAwards: 1 });
    expect(result.records).toHaveLength(1); // page slice only
  });

  it("applies search and fellowship filters to the page and the aggregate summary", async () => {
    const client = makeClient(route({}));
    createServerClient.mockReturnValue(client);

    await getScholarshipHistory({ search: "  Katherine ", fellowship_id: "7" });

    for (const query of listQueries(client)) {
      expect(query.filters).toContainEqual({
        column: "student_name",
        op: "ilike",
        value: "%Katherine%",
      });
      expect(query.filters).toContainEqual({ column: "fellowship_id", op: "eq", value: 7 });
    }
    // The aggregate receives the SAME escaped pattern and effective fellowship.
    expect(operationalQuery(client)?.rpcArgs).toEqual({
      p_search: "%Katherine%",
      p_fellowship_id: 7,
    });
  });

  it("accepts the legacy `filter` alias for the fellowship selector", async () => {
    const client = makeClient(route({}));
    createServerClient.mockReturnValue(client);

    await getScholarshipHistory({ filter: "all" });

    expect(pageQuery(client)?.filters.some((f) => f.column === "fellowship_id")).toBe(false);
  });

  it("returns an empty result with the error surfaced when the page query fails", async () => {
    const client = makeClient(
      route({
        list: { data: null, error: { message: "db unavailable" }, count: null },
        operational: { data: [{ total_records: 0, distinct_students: 0 }], error: null },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory();

    expect(result.records).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error?.message).toBe("db unavailable");
  });

  it("surfaces an aggregate failure as zero metrics without discarding the page", async () => {
    const client = makeClient(
      route({
        list: { data: [activeRecord], error: null, count: 1 },
        operational: { data: null, error: { message: "aggregate unavailable" } },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory();

    expect(result.error).toBeNull();
    expect(result.records).toHaveLength(1);
    expect(result.summary).toEqual({ records: 0, students: 0, repeatAwards: 0 });
  });

  it("returns no rows for an out-of-range page while preserving count and summary", async () => {
    const client = makeClient(
      route({
        list: { data: [activeRecord], error: null, count: 10 },
        operational: { data: [{ total_records: 1, distinct_students: 1 }], error: null },
      }),
    );
    createServerClient.mockReturnValue(client);

    const result = await getScholarshipHistory({ page: "3", pageSize: "25" });

    expect(result.pages).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.count).toBe(10);
    expect(result.summary.records).toBe(1);
    // An out-of-range page must not issue the bounded amendment query.
    expect(client.calls.some((q) => q.table === "scholarship_history_amendment")).toBe(false);
  });
});

describe("normalizeFellowshipFilter", () => {
  it("normalizes valid ids and ignores `all`/invalid/missing values", () => {
    expect(normalizeFellowshipFilter({ fellowship_id: "7" })).toBe("7");
    expect(normalizeFellowshipFilter({ filter: "9" })).toBe("9");
    expect(normalizeFellowshipFilter({ fellowship_id: "all" })).toBeNull();
    expect(normalizeFellowshipFilter({ fellowship_id: "abc" })).toBeNull();
    expect(normalizeFellowshipFilter({})).toBeNull();
  });
});

describe("summarizeOperationalAwards", () => {
  it("excludes voided awards from the operational counts", () => {
    const records = [activeRecord, voidedRecord] as unknown as Parameters<
      typeof summarizeOperationalAwards
    >[0];

    expect(summarizeOperationalAwards(records)).toEqual({
      records: 1,
      students: 1,
      repeatAwards: 0,
    });
  });
});
