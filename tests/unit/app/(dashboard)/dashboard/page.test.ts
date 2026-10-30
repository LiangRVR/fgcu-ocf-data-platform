/**
 * tests/unit/app/(dashboard)/dashboard/page.test.ts
 *
 * Dashboard monthly reporting contract:
 *   - the OCF reporting month (range + label) is captured ONCE in
 *     `getDashboardData` and the page renders that captured label, so a
 *     request that crosses a New York midnight cannot pair a label with a
 *     different month's counts;
 *   - the monthly meeting/no-show predicate uses the same inclusive-start /
 *     exclusive-end OCF month bounds for both counts;
 *   - the monthly no-show drill-down carries that same month back to
 *     `/advising` as a validated `from`/`to` date range, while the all-time
 *     no-show view is untouched.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { getNewYorkMonthRange } = vi.hoisted(() => ({
  getNewYorkMonthRange: vi.fn(),
}));

// Keep the real percentage/date helpers; only the "current month" clock is
// controlled so a second call can be detected as a label/propagation bug.
vi.mock("@/lib/utils/new-york-date", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/utils/new-york-date")>();
  return { ...actual, getNewYorkMonthRange };
});

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

import DashboardPage, { getDashboardData } from "@/app/(dashboard)/dashboard/page";

// ── Query-recording mock builder ────────────────────────────────────────────

type QueryRecord = { table: string; op: string; args: unknown[] };
type TableResponse = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
};

/**
 * The dashboard loader fans out into one thenable PostgREST builder per table.
 * The builder records every fluent call and resolves the per-table response on
 * `await`, thread `count` through for the stat queries, and never needs any
 * method the page does not actually use.
 */
function createMockClient(responses: Record<string, TableResponse> = {}) {
  const calls: QueryRecord[] = [];
  const from = vi.fn((table: string) => {
    const response = responses[table] ?? { data: [], error: null, count: 0 };
    const builder: Record<string, unknown> = {};
    const record = (op: string) =>
      vi.fn((...args: unknown[]) => {
        calls.push({ table, op, args });
        return builder;
      });
    builder.select = record("select");
    builder.eq = record("eq");
    builder.gte = record("gte");
    builder.lt = record("lt");
    builder.order = record("order");
    builder.limit = record("limit");
    builder.then = (resolve: (value: unknown) => void) => resolve(response);
    return builder;
  });
  return { client: { from } as never, calls };
}

const OCTOBER = {
  start: "2026-10-01",
  endExclusive: "2026-11-01",
  label: "October 2026",
};

beforeEach(() => {
  vi.clearAllMocks();
  getNewYorkMonthRange.mockReturnValue(OCTOBER);
});

// ── Monthly query predicates ────────────────────────────────────────────────

describe("getDashboardData monthly reporting range", () => {
  it("captures the reporting month once and returns it with the stats", async () => {
    const { client } = createMockClient();
    createServerClient.mockReturnValue(client);

    const result = await getDashboardData();

    expect(result.error).toBe(false);
    expect(getNewYorkMonthRange).toHaveBeenCalledTimes(1);
    if (result.error) return;
    expect(result.reportingMonth).toEqual(OCTOBER);
  });

  it("bounds both monthly counts to the captured OCF month", async () => {
    const { client, calls } = createMockClient();
    createServerClient.mockReturnValue(client);

    await getDashboardData();

    const meetingQueries = calls.filter(
      (call) => call.table === "advising_meeting"
    );
    // Two monthly queries (all meetings + no-shows), each half-open on the
    // same captured month: inclusive start, exclusive next-month start.
    expect(
      meetingQueries.filter((call) => call.op === "gte").map((call) => call.args)
    ).toEqual([
      ["meeting_date", "2026-10-01"],
      ["meeting_date", "2026-10-01"],
    ]);
    expect(
      meetingQueries.filter((call) => call.op === "lt").map((call) => call.args)
    ).toEqual([
      ["meeting_date", "2026-11-01"],
      ["meeting_date", "2026-11-01"],
    ]);
    // Only the no-show count is additionally constrained by no_show = true.
    expect(
      meetingQueries.filter((call) => call.op === "eq").map((call) => call.args)
    ).toEqual([["no_show", true]]);
  });
});

// ── Label propagation + drill-down URL semantics ────────────────────────────

describe("DashboardPage monthly label and drill-down", () => {
  it("renders the label captured by getDashboardData instead of re-reading the clock", async () => {
    // A second call would return the NEXT month, exactly like a request that
    // crossed midnight between the data fetch and render.
    getNewYorkMonthRange
      .mockReturnValueOnce(OCTOBER)
      .mockReturnValue({
        start: "2026-11-01",
        endExclusive: "2026-12-01",
        label: "November 2026",
      });
    const { client } = createMockClient();
    createServerClient.mockReturnValue(client);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(getNewYorkMonthRange).toHaveBeenCalledTimes(1);
    expect(html).toContain("October 2026");
    expect(html).not.toContain("November 2026");
  });

  it("links monthly no-show drill-downs to the same validated month", async () => {
    const { client } = createMockClient();
    createServerClient.mockReturnValue(client);

    const html = renderToStaticMarkup(await DashboardPage());
    const monthlyHref =
      "/advising?no_show=yes&amp;from=2026-10-01&amp;to=2026-10-31";

    // Both monthly no-show entry points (stat card + attention queue) carry
    // the same canonical month range.
    expect(html.split(monthlyHref)).toHaveLength(3);
    // The card no longer links to the unbounded all-time no-show view.
    expect(html).not.toContain('href="/advising?no_show=yes"');
  });

  it("links the monthly advising total to the same month without changing its all-attendance definition", async () => {
    const { client } = createMockClient();
    createServerClient.mockReturnValue(client);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain(
      'href="/advising?from=2026-10-01&amp;to=2026-10-31"'
    );
    expect(html).not.toContain('href="/advising"');
  });

  it("derives the inclusive month end across a year boundary", async () => {
    getNewYorkMonthRange.mockReturnValue({
      start: "2026-12-01",
      endExclusive: "2027-01-01",
      label: "December 2026",
    });
    const { client } = createMockClient();
    createServerClient.mockReturnValue(client);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain(
      "/advising?no_show=yes&amp;from=2026-12-01&amp;to=2026-12-31"
    );
  });

  it("keeps the captured month label on the data-fetch failure branch", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    createServerClient.mockReturnValue({
      from: vi.fn(() => {
        throw new Error("db timeout");
      }),
    } as never);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("Could not load dashboard data.");
    expect(html).toContain("October 2026");
    expect(getNewYorkMonthRange).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
