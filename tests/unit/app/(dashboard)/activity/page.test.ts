/**
 * tests/unit/app/(dashboard)/activity/page.test.ts
 *
 * Activity (global audit log) page: complete filter-normalization + query
 * shape contract (R11/R12).
 *
 * The page builds the server query from untrusted URL searchParams through
 * explicit allowlists and the shared pagination helpers:
 *
 *   - exact count over the explicit safe projection
 *     (`select(AUDIT_ACTIVITY_SAFE_COLUMNS, { count: "exact" })`) with a
 *     deterministic newest-first `occurred_at DESC, audit_id DESC` tie-broken
 *     order and an inclusive bounded `.range(offset, to)`;
 *   - allowlisted `entity` and `action` values become `.eq` filters; actor /
 *     student / fellowship are normalized free-text `.ilike` searches with
 *     PostgREST wildcard escaping; `from`/`to` are validated `YYYY-MM-DD`
 *     dates applied as half-open `gte`/`lt` bounds on `occurred_at` — any
 *     other input is dropped (and, because it differs from the raw URL, the
 *     page issues a canonical redirect instead of querying with bogus values);
 *   - untrusted `page`/`pageSize` normalize to the 25/50/100 contract, and an
 *     out-of-range page collapses to the last valid page using the exact
 *     total count;
 *   - rendered rows use friendly typed diff text only — raw JSON payloads,
 *     unknown/sensitive diff fields, and Auth bindings never reach the markup
 *     (R7), and redundant finalist flags are suppressed only alongside a
 *     stage change. The raw diff needed for typed changes is read by the
 *     server in ONE bounded batch from the `audit_event` base table through the
 *     server-only service-role client (the raw `changes` column is revoked from
 *     every client role), never from the browser-safe `audit_activity`
 *     projection.
 *
 * `createServerClient`, the server-only `createAdminClient`, and
 * `next/navigation`'s `redirect` are mocked; the async server component is
 * awaited directly and rendered to static markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect }));

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

import ActivityPage from "@/app/(dashboard)/activity/page";
import { AUDIT_ACTIVITY_SAFE_COLUMNS, AUDIT_RAW_DIFF_COLUMNS } from "@/lib/audit/read";

// ── Query-recording mock builder ───────────────────────────────────────────

type QueryRecord = { op: string; args: unknown[] };

function makeSupabase(payload: {
  data?: unknown[];
  count?: number | null;
  error?: unknown;
} = {}) {
  // The page issues the browser-safe `audit_activity` view query; the read
  // boundary then issues ONE bounded raw-diff batch against `audit_event` via
  // the server-only service-role client. Query recordings are split by table so
  // assertions target the view query.
  const queries: QueryRecord[] = [];
  const rawQueries: QueryRecord[] = [];
  const client = {
    from: vi.fn((table: string) => {
      const sink = table === "audit_event" ? rawQueries : queries;
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: vi.fn((...args: unknown[]) => {
          sink.push({ op: "select", args });
          return builder;
        }),
        eq: vi.fn((...args: unknown[]) => {
          sink.push({ op: "eq", args });
          return builder;
        }),
        ilike: vi.fn((...args: unknown[]) => {
          sink.push({ op: "ilike", args });
          return builder;
        }),
        gte: vi.fn((...args: unknown[]) => {
          sink.push({ op: "gte", args });
          return builder;
        }),
        lt: vi.fn((...args: unknown[]) => {
          sink.push({ op: "lt", args });
          return builder;
        }),
        in: vi.fn((...args: unknown[]) => {
          sink.push({ op: "in", args });
          return builder;
        }),
        order: vi.fn((...args: unknown[]) => {
          sink.push({ op: "order", args });
          return builder;
        }),
        range: vi.fn((...args: unknown[]) => {
          sink.push({ op: "range", args });
          return Promise.resolve({
            data: payload.data ?? [],
            count: payload.count ?? 0,
            error: payload.error ?? null,
          });
        }),
      });
      return builder;
    }),
  };
  createServerClient.mockReturnValue(client);
  createAdminClient.mockReturnValue(client);
  return { client, queries, rawQueries };
}

function makeActivityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audit_id: 1,
    action: "updated",
    entity_type: "student",
    entity_id: 5,
    student_name: "Sam Student",
    fellowship_name: null,
    actor_name_snapshot: "Jordan Lee",
    occurred_at: "2026-10-12T14:30:00.000Z",
    reason: "Profile reviewed",
    actor_advisor_id: 12,
    changes: { gpa: { old: 3.4, new: 3.9 } },
    old_values: { email: "secret-old@example.com" },
    new_values: { email: "secret-new@example.com" },
    ...overrides,
  };
}

function ops(queries: QueryRecord[], op: string): unknown[][] {
  return queries.filter((q) => q.op === op).map((q) => q.args);
}

async function renderActivity(params: Record<string, string> = {}) {
  redirect.mockClear();
  const element = await ActivityPage({
    searchParams: Promise.resolve(params),
  } as never);
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Activity page query shape (exact count, tie-broken order, bounded range)", () => {
  it("requests an EXACT count, newest-first order with the audit_id tie-breaker, and the first-page range", async () => {
    const { queries } = makeSupabase({ data: [], count: 0 });
    await renderActivity({});

    expect(ops(queries, "select")).toEqual([[AUDIT_ACTIVITY_SAFE_COLUMNS, { count: "exact" }]]);
    expect(String(ops(queries, "select")[0][0])).not.toContain("old_values");
    expect(String(ops(queries, "select")[0][0])).not.toContain("new_values");
    expect(ops(queries, "order")).toEqual([
      ["occurred_at", { ascending: false }],
      ["audit_id", { ascending: false }],
    ]);
    expect(ops(queries, "range")).toEqual([[0, 24]]);
    expect(ops(queries, "eq")).toEqual([]);
    expect(ops(queries, "ilike")).toEqual([]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("reads the server-only raw diff from the audit_event base table in ONE bounded batch", async () => {
    const { rawQueries } = makeSupabase({
      data: [makeActivityRow({ audit_id: 1 }), makeActivityRow({ audit_id: 2 })],
      count: 2,
    });
    await renderActivity({});

    expect(ops(rawQueries, "select")).toEqual([[AUDIT_RAW_DIFF_COLUMNS]]);
    expect(ops(rawQueries, "in")).toEqual([["audit_id", [1, 2]]]);
    expect(ops(rawQueries, "range")).toEqual([[0, 1]]);
    // The browser-safe view projection never carries the raw diff column.
    expect(AUDIT_ACTIVITY_SAFE_COLUMNS).not.toContain("changes");
  });

  it("computes exact inclusive ranges for later pages at a bounded page size", async () => {
    const { queries } = makeSupabase({ count: 250 });
    await renderActivity({ page: "3", pageSize: "100" });

    expect(ops(queries, "range")).toEqual([[200, 299]]);
    expect(ops(queries, "select")).toEqual([[AUDIT_ACTIVITY_SAFE_COLUMNS, { count: "exact" }]]);
    expect(String(ops(queries, "select")[0][0])).not.toContain("old_values");
    expect(String(ops(queries, "select")[0][0])).not.toContain("new_values");
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("Activity page entity/action allowlists", () => {
  it("applies ONLY allowlisted entity filters", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ entity: "student" });

    expect(ops(queries, "eq")).toContainEqual(["entity_type", "student"]);
    expect(ops(queries, "eq")).not.toContainEqual(expect.arrayContaining(["action"]));
    expect(redirect).not.toHaveBeenCalled();
  });

  it("applies ONLY allowlisted action filters (past-tense event vocabulary)", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ action: "role_changed" });

    expect(ops(queries, "eq")).toContainEqual(["action", "role_changed"]);
    expect(ops(queries, "eq")).not.toContainEqual(expect.arrayContaining(["entity_type"]));
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("Activity page free-text and date filter normalization", () => {
  it("normalizes actor/student/fellowship search text and escapes PostgREST wildcards", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ actor: "A_li%ce_J.*", student: "O'Brien", fellowship: "100% Fresh" });

    // safeLike: escape \, %, _, * so a crafted search cannot inject filters.
    expect(ops(queries, "ilike")).toEqual([
      ["actor_name_snapshot", "%A\\_li\\%ce\\_J.\\*%"],
      ["student_name", "%O'Brien%"],
      ["fellowship_name", "%100\\% Fresh%"],
    ]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("canonicalizes search text (trim + control-strip + 80-char cap) via a redirect", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ actor: "  A_li%ce\u0000 J.  " });

    // The query still runs with the NORMALIZED (escaped) value first, then the
    // page redirects to the canonical URL because the raw param differs.
    expect(ops(queries, "ilike")).toEqual([["actor_name_snapshot", "%A\\_li\\%ce J.%"]]);
    // URLSearchParams encodes "%" as %25 and spaces as "+".
    expect(redirect).toHaveBeenCalledWith("/activity?actor=A_li%25ce+J.&page=1&pageSize=25");
  });

  it("truncates search text to 80 characters before querying", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ student: "L".repeat(200) });

    const [ilike] = ops(queries, "ilike");
    expect(ilike?.[0]).toBe("student_name");
    expect(String(ilike?.[1])).toHaveLength(80 + 2); // "%" + 80 chars + "%"
  });

  it("applies validated from/to dates as half-open occurred_at bounds", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ from: "2026-10-01", to: "2026-10-12" });

    expect(ops(queries, "gte")).toEqual([["occurred_at", "2026-10-01T04:00:00.000Z"]]);
    // `lt` excludes the inclusive `to` day by bounding at the next NY local
    // midnight (04:00Z while America/New_York is on daylight time).
    expect(ops(queries, "lt")).toEqual([["occurred_at", "2026-10-13T04:00:00.000Z"]]);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("drops non-YYYY-MM-DD date inputs and canonicalizes", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ from: "10/12/2026", to: "2026-1-1" });

    // Neither value matches the required YYYY-MM-DD shape, so no gte/lt query
    // is emitted and the page redirects to the canonical (filter-free) URL.
    expect(ops(queries, "gte")).toEqual([]);
    expect(ops(queries, "lt")).toEqual([]);
    expect(redirect).toHaveBeenCalledWith("/activity?page=1&pageSize=25");
  });

  it("drops non-allowlisted entity/action values before querying and canonicalizes", async () => {
    const { queries } = makeSupabase();
    await renderActivity({ entity: "student; drop students", action: "purge--" });

    // Nothing survives normalization: no `.eq` filters are emitted at all.
    expect(ops(queries, "eq")).toEqual([]);
    expect(redirect).toHaveBeenCalledWith("/activity?page=1&pageSize=25");
  });

  it("applies the FULL canonical filter surface in order (entity/action/actor/student/fellowship/from/to)", async () => {
    const { queries } = makeSupabase();
    await renderActivity({
      entity: "advisor",
      action: "role_changed",
      actor: "Amy",
      student: "Sam",
      fellowship: "Freshman",
      from: "2026-10-01",
      to: "2026-10-12",
    });

    expect(ops(queries, "eq")).toEqual([
      ["entity_type", "advisor"],
      ["action", "role_changed"],
    ]);
    expect(ops(queries, "ilike")).toEqual([
      ["actor_name_snapshot", "%Amy%"],
      ["student_name", "%Sam%"],
      ["fellowship_name", "%Freshman%"],
    ]);
    expect(ops(queries, "gte")).toEqual([["occurred_at", "2026-10-01T04:00:00.000Z"]]);
    expect(ops(queries, "lt")).toEqual([["occurred_at", "2026-10-13T04:00:00.000Z"]]);
    expect(ops(queries, "range")).toEqual([[0, 24]]);
    // Deterministic ordering holds for every filter combination.
    expect(ops(queries, "order")).toEqual([
      ["occurred_at", { ascending: false }],
      ["audit_id", { ascending: false }],
    ]);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("Activity page pagination canonicalization", () => {
  it("normalizes invalid page/pageSize input and redirects to the canonical URL", async () => {
    makeSupabase();
    await renderActivity({ page: "abc", pageSize: "777" });

    expect(redirect).toHaveBeenCalledWith("/activity?page=1&pageSize=25");
  });

  it("collapses an out-of-range page to the last valid page using the exact total count", async () => {
    const { queries } = makeSupabase({ count: 40 });
    await renderActivity({ page: "5" });

    // The single bounded query for the REQUESTED page runs first, then the
    // exact total (40 rows → 2 pages) collapses the page to 2.
    expect(ops(queries, "range")).toEqual([[100, 124]]);
    expect(redirect).toHaveBeenCalledWith("/activity?page=2&pageSize=25");
  });

  it("keeps page 1 for an empty total (no page beyond the empty first page)", async () => {
    makeSupabase({ count: 0 });
    await renderActivity({ page: "3" });

    expect(redirect).toHaveBeenCalledWith("/activity?page=1&pageSize=25");
  });
});

describe("Activity page rendering (safe presentation)", () => {
  it("renders typed diff text and suppresses finalist flags only with a stage change", async () => {
    makeSupabase({
      data: [
        makeActivityRow({
          audit_id: 1,
          entity_type: "application",
          student_name: "Sam Student",
          changes: {
            stage_of_application: { old: "applied", new: "finalist" },
            is_finalist: { old: false, new: true },
            is_semi_finalist: { old: false, new: true },
          },
        }),
      ],
      count: 1,
    });
    const markup = await renderActivity({});

    // Friendly action label plus the accessible user-facing entity/subject
    // rendering ("<Entity> · <subject>") produced by AuditHistory.
    expect(markup).toContain("Application · Sam Student");
    expect(markup).toContain("Updated");
    // Typed diff rendering for the application stage transition.
    expect(markup).toContain("Application Stage");
    expect(markup).toContain("applied");
    expect(markup).toContain("finalist");
    // The redundant finalist flags were suppressed alongside the stage change.
    expect(markup).not.toContain("Semi-finalist");
  });

  it("renders friendly null / numeric / boolean text for a student update", async () => {
    makeSupabase({
      data: [
        makeActivityRow({
          changes: { gpa: { old: null, new: 3.9 }, us_citizen: { old: false, new: true } },
        }),
      ],
      count: 1,
    });
    const markup = await renderActivity({});

    expect(markup).toContain("GPA");
    expect(markup).toContain("Not set");
    expect(markup).toContain("3.9");
    expect(markup).toContain("U.S. Citizen");
    expect(markup).toContain("Yes");
  });

  it("keeps finalist flags when an update has NO stage change", async () => {
    makeSupabase({
      data: [
        makeActivityRow({
          entity_type: "application",
          student_name: "Sam Student",
          changes: {
            is_finalist: { old: false, new: true },
            destination_country: { old: null, new: "United Kingdom" },
          },
        }),
      ],
      count: 1,
    });
    const markup = await renderActivity({});

    expect(markup).toContain("Finalist");
    expect(markup).toContain("Destination Country");
    expect(markup).toContain("United Kingdom");
  });

  it("NEVER renders raw JSON payloads, unknown diff fields, or Auth bindings", async () => {
    makeSupabase({
      data: [
        makeActivityRow({
          changes: {
            internal_note: { old: "secret-diff", new: "secret-diff" },
            gpa: { old: 3.0, new: 3.2 },
          },
        }),
      ],
      count: 1,
    });
    const markup = await renderActivity({});

    expect(markup).toContain("GPA");
    // Old/new payload columns, unknown diff secrets, and Auth bindings never
    // reach the markup.
    expect(markup).not.toContain("secret-diff");
    expect(markup).not.toContain("old_values");
    expect(markup).not.toContain("new_values");
    expect(markup).not.toContain("actor_advisor_id");
    expect(markup).not.toContain("Internal Note");
  });

  it("renders the expanded filter form allowlists and bounded page-size options", async () => {
    makeSupabase({ data: [], count: 0 });
    const markup = await renderActivity({});

    expect(markup).toContain("Activity");
    for (const label of ["All record types", "Advising Meeting", "Scholarship History", "Fellowship Thursday"]) {
      expect(markup).toContain(label);
    }
    for (const label of ["All changes", "Role Changed", "Correction Added", "Legacy State Captured", "Voided"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Search actor name");
    expect(markup).toContain("Search student name");
    expect(markup).toContain("Search fellowship");
    // Bounded page-size contract.
    expect(markup).toContain("Rows per page");
    expect(markup).toContain('<option value="50">50</option>');
    expect(markup).toContain('<option value="100">100</option>');
  });

  it("builds navigate hrefs that preserve applied filters", async () => {
    makeSupabase({ data: [], count: 60 });
    const markup = await renderActivity({
      entity: "student",
      action: "updated",
      actor: "Amy",
      from: "2026-10-01",
    });

    // Static markup escapes `&` in query strings as `&amp;`.
    expect(markup).toContain(
      'href="/activity?entity=student&amp;action=updated&amp;actor=Amy&amp;from=2026-10-01&amp;page=2&amp;pageSize=25"'
    );
    expect(markup).toContain('<option value="50">50</option>');
  });
});