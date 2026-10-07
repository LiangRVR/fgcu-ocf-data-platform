import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/students/students-table", () => ({ StudentsTable: () => null }));

const { createServerClient, queries } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  queries: [] as Array<{
    table: string;
    columns: string;
    calls: Array<{ op: string; args: unknown[] }>;
  }>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

vi.mock("next/navigation", () => ({
  redirect: (href: string): never => {
    throw new Error(`REDIRECT:${href}`);
  },
}));

import {
  getRosterCounts,
  getStudents,
  StudentsContent,
} from "@/app/(dashboard)/students/page";

type QueryResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};

/**
 * Chainable builder covering every method the students loader exercises:
 * `is`/`not` probes, `eq`/`or` filters, `order`, inclusive `range`, the
 * `head: true` select for roster counts, and a `.then` so `Promise.all` on the
 * count builders resolves like real PostgREST postgrest-js builders.
 */
interface MockBuilder {
  select: (...args: unknown[]) => MockBuilder;
  is: (...args: unknown[]) => MockBuilder;
  not: (...args: unknown[]) => MockBuilder;
  eq: (...args: unknown[]) => MockBuilder;
  or: (...args: unknown[]) => MockBuilder;
  order: (...args: unknown[]) => MockBuilder;
  range: (...args: unknown[]) => MockBuilder;
  then: <T>(onFulfilled: (value: QueryResult) => T) => Promise<T>;
}

function makeClient(responses: Record<string, QueryResult | QueryResult[]>) {
  // Per-table call index so a table can return a distinct response for each
  // independent builder (e.g. the roster total vs. the CH-subset count).
  const callIndex: Record<string, number> = {};
  return {
    from: (table: string) => {
      const index = callIndex[table] ?? 0;
      callIndex[table] = index + 1;
      const spec = responses[table];
      const response = Array.isArray(spec) ? spec[index] : spec;

      const record = { table, columns: "", calls: [] as Array<{ op: string; args: unknown[] }> };
      queries.push(record);

      const resolve = () =>
        Promise.resolve(response ?? { data: [], error: null, count: 0 });

      const builder: MockBuilder = {
        select: (...args) => {
          record.columns = String(args[0]);
          record.calls.push({ op: "select", args });
          return builder;
        },
        is: (...args) => {
          record.calls.push({ op: "is", args });
          return builder;
        },
        not: (...args) => {
          record.calls.push({ op: "not", args });
          return builder;
        },
        eq: (...args) => {
          record.calls.push({ op: "eq", args });
          return builder;
        },
        or: (...args) => {
          record.calls.push({ op: "or", args });
          return builder;
        },
        order: (...args) => {
          record.calls.push({ op: "order", args });
          return builder;
        },
        range: (...args) => {
          record.calls.push({ op: "range", args });
          return builder;
        },
        then: (onFulfilled) => resolve().then(onFulfilled),
      };
      return builder;
    },
  };
}

function studentListQuery() {
  return queries.find((q) => q.table === "student_list");
}

function studentListQueries() {
  return queries.filter((q) => q.table === "student_list");
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
});

describe("getStudents", () => {
  it("loads an exact-count page of the active roster with a deterministic tie-breaker", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: {
          data: [
            { student_id: 5, full_name: "Ava" },
            { student_id: 4, full_name: "Ben" },
          ],
          error: null,
          count: 42,
        },
      }),
    );

    const result = await getStudents({ page: "2", pageSize: "25" });

    expect(result).toMatchObject({ ok: true, count: 42, pages: 2 });
    if (!result.ok) throw new Error("expected an ok result");
    expect(result.students).toHaveLength(2);
    expect(result.pagination).toEqual({ page: 2, pageSize: 25, offset: 25, to: 49 });

    const st = studentListQuery();
    expect(st?.columns).toBe("*");
    expect(st?.calls).toContainEqual({ op: "select", args: ["*", { count: "exact" }] });
    expect(st?.calls).toContainEqual({ op: "is", args: ["archived_at", null] });
    expect(st?.calls).toContainEqual({ op: "order", args: ["student_id", { ascending: false }] });
    expect(st?.calls).toContainEqual({ op: "range", args: [25, 49] });
  });

  it("applies exception-view predicates at the database boundary", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ view: "no-apps", standing: "Junior", flag: "ch", page: "1" });

    const st = studentListQuery();
    expect(st?.calls).toContainEqual({ op: "is", args: ["archived_at", null] });
    expect(st?.calls).toContainEqual({ op: "eq", args: ["has_application", false] });
    // Standing/badge filters only apply to the browsable all/archived views.
    expect(st?.calls.some((c) => c.op === "eq" && c.args[0] === "class_standing")).toBe(false);
    expect(st?.calls.some((c) => c.op === "eq" && c.args[0] === "is_ch_student")).toBe(false);
  });

  it("uses NOT archived_at for the explicit archive view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ view: "archived" });

    expect(studentListQuery()?.calls).toContainEqual({
      op: "not",
      args: ["archived_at", "is", null],
    });
  });

  it("sanitizes the free-text term and matches a numeric term against a student id", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ search: "  Ava,,(x)  ", page: "1" });
    expect(studentListQuery()?.calls).toContainEqual({
      op: "or",
      args: ["full_name.ilike.%Ava x%,email.ilike.%Ava x%"],
    });

    queries.length = 0;
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ search: "42", page: "1" });
    expect(studentListQuery()?.calls).toContainEqual({
      op: "or",
      args: ["full_name.ilike.%42%,email.ilike.%42%,student_id.eq.42"],
    });
  });

  it("orders the allowlisted sort with nulls last, then the student_id tie-breaker", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ sort: "gpa", direction: "desc", page: "1" });

    const orders = studentListQuery()?.calls.filter((c) => c.op === "order").map((c) => c.args) ?? [];
    expect(orders).toEqual([
      ["gpa", { ascending: false, nullsFirst: false }],
      ["student_id", { ascending: false }],
    ]);
  });

  it("ignores unknown sort/standing values and falls back to the default order", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
      }),
    );

    await getStudents({ sort: "email;drop table", direction: "sideways", standing: "Superstar" });

    const orders = studentListQuery()?.calls.filter((c) => c.op === "order").map((c) => c.args) ?? [];
    expect(orders).toEqual([["student_id", { ascending: false }]]);
    expect(
      studentListQuery()?.calls.some((c) => c.op === "eq" && c.args[0] === "class_standing"),
    ).toBe(false);
  });
});

describe("getRosterCounts", () => {
  it("counts the full roster and the CH subset with independent head-only builders", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: [
          { data: [], error: null, count: 84 },
          { data: [], error: null, count: 12 },
        ],
      }),
    );

    const counts = await getRosterCounts("all");

    expect(counts).toEqual({ baseCount: 84, chCount: 12 });

    // Two distinct builders, each with its own head-only exact-count select.
    const [base, ch] = studentListQueries();
    expect(studentListQueries()).toHaveLength(2);
    for (const q of [base, ch]) {
      expect(q?.calls.filter((c) => c.op === "select")).toEqual([
        { op: "select", args: ["*", { count: "exact", head: true }] },
      ]);
      expect(q?.calls).toContainEqual({ op: "is", args: ["archived_at", null] });
    }
    // The base builder carries only the roster predicate; the CH subset
    // modifier is applied to a separate builder so it can never leak into
    // (or mutate) the base count.
    expect(base?.calls.some((c) => c.op === "eq" && c.args[0] === "is_ch_student")).toBe(false);
    expect(ch?.calls).toContainEqual({ op: "eq", args: ["is_ch_student", true] });
  });

  it("applies the archived predicate to both counts", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: [
          { data: [], error: null, count: 30 },
          { data: [], error: null, count: 4 },
        ],
      }),
    );

    const counts = await getRosterCounts("archived");

    expect(counts).toEqual({ baseCount: 30, chCount: 4 });
    const [base, ch] = studentListQueries();
    expect(base?.calls).toContainEqual({ op: "not", args: ["archived_at", "is", null] });
    expect(ch?.calls).toContainEqual({ op: "not", args: ["archived_at", "is", null] });
    expect(base?.calls.some((c) => c.op === "eq" && c.args[0] === "is_ch_student")).toBe(false);
    expect(ch?.calls).toContainEqual({ op: "eq", args: ["is_ch_student", true] });
  });
});

describe("StudentsContent canonicalization", () => {
  it("redirects an out-of-range page to the last valid page, preserving the exception view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [{ student_id: 1 }], error: null, count: 1 },
        application: { data: [], error: null, count: 5 },
        fellowship: { data: [], error: null, count: 2 },
      }),
    );

    await expect(
      StudentsContent({ view: "no-apps", page: "9", pageSize: "25", standing: "Junior" }),
    ).rejects.toThrow("REDIRECT:/students?view=no-apps&page=1&pageSize=25&standing=Junior");
  });

  it("normalizes a non-canonical pageSize and keeps the archive view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: { data: [], error: null, count: 0 },
        application: { data: [], error: null, count: 5 },
        fellowship: { data: [], error: null, count: 2 },
      }),
    );

    await expect(
      StudentsContent({ view: "archived", page: "1", pageSize: "025" }),
    ).rejects.toThrow("REDIRECT:/students?view=archived&page=1&pageSize=25");
  });

  it("renders the count-driven banner for a canonical exception view", async () => {
    createServerClient.mockReturnValue(
      makeClient({
        student_list: {
          data: [
            { student_id: 1, full_name: "Ava" },
            { student_id: 2, full_name: "Ben" },
            { student_id: 3, full_name: "Cid" },
          ],
          error: null,
          count: 3,
        },
        application: { data: [], error: null, count: 0 },
        fellowship: { data: [], error: null, count: 0 },
      }),
    );

    const markup = renderToStaticMarkup(
      await StudentsContent({ view: "no-apps", page: "1", pageSize: "25" }),
    );

    expect(markup).toContain("3 students have had no applications recorded.");
    expect(markup).toContain("3 open");
  });
});