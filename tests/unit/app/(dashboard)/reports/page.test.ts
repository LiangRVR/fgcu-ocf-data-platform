import { createElement } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient, selectedQueries, paginationCalls } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  selectedQueries: [] as Array<{ table: string; columns: string }>,
  // Records any `.range(...)`/`.limit(...)` a report query applies. Reports
  // must read the full authorized dataset, so this must always stay empty.
  paginationCalls: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

// ── Functions under test ─────────────────────────────────────────────────────

import ReportsPage, {
  getReportsData,
  ReportsUnavailable,
} from "@/app/(dashboard)/reports/page";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Render an async server component (RSC) and return its full SSR HTML.
 * `renderToString` is synchronous and cannot await async RSC payloads, so the
 * page-level tests read the `renderToReadableStream` output instead.
 */
async function renderPage(node: ReturnType<typeof createElement>): Promise<string> {
  const stream = await renderToReadableStream(node);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

function createMockClient(
  responses: Record<string, { data?: unknown; error?: { message: string } | null }>
) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn((columns: string) => {
        selectedQueries.push({ table, columns });
        const response = responses[table] ?? { data: [], error: null };
        // The report loader awaits `.select(...)` directly. Attach pagination
        // spies to the thenable so a `.range()`/`.limit()` regression is
        // observable without changing the awaited value.
        const query = Promise.resolve(response) as Promise<typeof response> & {
          range: (from: number, to: number) => unknown;
          limit: (count: number) => unknown;
        };
        query.range = vi.fn((from: number, to: number) => {
          paginationCalls.push(`range:${from}-${to}`);
          return query;
        });
        query.limit = vi.fn((count: number) => {
          paginationCalls.push(`limit:${count}`);
          return query;
        });
        return query;
      }),
    })),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectedQueries.length = 0;
  paginationCalls.length = 0;
});

// ── getReportsData ──────────────────────────────────────────────────────────

describe("getReportsData", () => {
  it("returns { ok: false } when any underlying query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: { message: "db timeout" } },
        student: { data: [], error: null },
        effective_fellowship_thursday: { data: [], error: null },
      })
    );

    await expect(getReportsData()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when a query throws", async () => {
    createServerClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockRejectedValue(new Error("network failure")),
      }),
    } as never);

    await expect(getReportsData()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the server client construction throws", async () => {
    // A THROWN construction/request-context error (e.g. cookies() outside a
    // request scope) is inside the failure boundary: the loader still resolves
    // { ok: false } instead of escaping to an uncaught page error.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    await expect(getReportsData()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, metrics } for successful empty data", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: null },
        student: { data: [], error: null },
        effective_fellowship_thursday: { data: [], error: null },
      })
    );

    const result = await getReportsData();

    const meetingQuery = selectedQueries.find(({ table }) => table === "advising_meeting");
    expect(meetingQuery?.columns).toContain("application_id");
    expect(meetingQuery?.columns).toContain("application!advising_meeting_application_id_fkey");
    expect(meetingQuery?.columns).toContain("fellowship(fellowship_name)");

    // Operational FT reporting must read the effective view, never the raw
    // base table, so corrections affect the totals and cannot inflate counts.
    const ftQuery = selectedQueries.find(({ table }) => table === "effective_fellowship_thursday");
    expect(ftQuery?.columns).toContain("attended");
    expect(selectedQueries.some(({ table }) => table === "fellowship_thursday")).toBe(false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.metrics.totals).toEqual({
      students: 0,
      applications: 0,
      meetings: 0,
      ftAttendees: 0,
      awarded: 0,
    });
    expect(result.metrics.applicationsByStage).toEqual([]);
    expect(result.metrics.byClassStanding).toEqual([]);
    expect(result.metrics.advisorActivity).toEqual([]);
    expect(result.metrics.advisingSessionsByStudent).toEqual([]);
    expect(result.metrics.advisingSessionsByStudentApplication).toEqual([]);
    expect(result.metrics.advisingSessionsByFellowship).toEqual([]);
    expect(result.metrics.noShowTrend).toEqual([]);
  });

  it("never applies a pagination range or limit to any report query", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: null },
        student: { data: [], error: null },
        effective_fellowship_thursday: { data: [], error: null },
      })
    );

    const result = await getReportsData();
    expect(result.ok).toBe(true);

    // Query shape contract: reports read full source sets. Any `.range()` or
    // `.limit()` on a report query would make a metric page-dependent.
    expect(paginationCalls).toEqual([]);

    // Every source is read, and no paginated list view is substituted for the
    // authoritative source tables/effective view.
    expect(selectedQueries.map(({ table }) => table).sort()).toEqual([
      "advising_meeting",
      "application",
      "effective_fellowship_thursday",
      "student",
    ]);
  });

  it("aggregates metrics over the complete authorized dataset, beyond one list page", async () => {
    const studentCount = 130;
    const applicationCount = 120;
    const meetingCount = 70;
    const ftAttendeeCount = 45;

    const students = Array.from({ length: studentCount }, (_, i) => ({
      student_id: i + 1,
      full_name: `Student ${i + 1}`,
      major: null,
      class_standing: "Senior",
    }));
    const applications = Array.from({ length: applicationCount }, (_, i) => ({
      student_id: (i % studentCount) + 1,
      fellowship_id: 1,
      application_year: 2026,
      stage_of_application: "Submitted",
      is_finalist: false,
      is_semi_finalist: false,
      student: null,
      fellowship: { fellowship_name: "Test Fellowship" },
    }));
    const meetings = Array.from({ length: meetingCount }, (_, i) => ({
      student_id: (i % studentCount) + 1,
      advisor_id: 1,
      no_show: false,
      meeting_date: "2026-01-15",
      advisor: { advisor_name: "Advisor" },
      application_id: null,
      application: null,
    }));
    const ftRows = Array.from({ length: ftAttendeeCount }, (_, i) => ({
      student_id: i + 1,
      attended: true,
    }));

    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: applications, error: null },
        advising_meeting: { data: meetings, error: null },
        student: { data: students, error: null },
        effective_fellowship_thursday: { data: ftRows, error: null },
      })
    );

    const result = await getReportsData();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Counts and groupings cover the whole authorized set even though every
    // count exceeds the largest allowed list page size (100), proving report
    // metrics are not computed from a paginated slice.
    expect(result.metrics.totals.students).toBe(studentCount);
    expect(result.metrics.totals.applications).toBe(applicationCount);
    expect(result.metrics.totals.meetings).toBe(meetingCount);
    expect(result.metrics.totals.ftAttendees).toBe(ftAttendeeCount);
    expect(result.metrics.applicationsByStage).toEqual([
      { stage: "Submitted", count: applicationCount },
    ]);
    expect(result.metrics.byClassStanding).toEqual([
      { standing: "Senior", count: studentCount },
    ]);
    expect(result.metrics.advisorActivity[0]).toMatchObject({
      total: meetingCount,
      noShows: 0,
    });

    // Completeness is only meaningful if the loader itself was never paged.
    expect(paginationCalls).toEqual([]);
  });
});

// ── ReportsUnavailable ──────────────────────────────────────────────────────

describe("ReportsUnavailable", () => {
  it("renders accessible unavailable copy", () => {
    const html = renderToString(createElement(ReportsUnavailable));

    expect(html).toContain("Reports are currently unavailable");
    expect(html).toContain("Refresh reports");
    expect(html).toContain('role="alert"');
  });
});

// ── ReportsPage (page-level failure branch) ─────────────────────────────────

describe("ReportsPage", () => {
  it("renders the unavailable UI when the server client rejects", async () => {
    createServerClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockRejectedValue(new Error("network failure")),
      }),
    } as never);

    const html = await renderPage(createElement(ReportsPage));

    expect(html).toContain("Reports are currently unavailable");
    expect(html).toContain("Refresh reports");
    expect(html).toContain('role="alert"');
  });

  it("renders the unavailable UI when the server client construction throws", async () => {
    // A THROWN client construction (request-context rejection) must render the
    // explicit unavailable state, never an uncaught page error.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    const html = await renderPage(createElement(ReportsPage));

    expect(html).toContain("Reports are currently unavailable");
    expect(html).toContain("Refresh reports");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("No data yet.");
  });

  it("renders the unavailable UI when any query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: { message: "db timeout" } },
        student: { data: [], error: null },
        effective_fellowship_thursday: { data: [], error: null },
      })
    );

    const html = await renderPage(createElement(ReportsPage));

    expect(html).toContain("Reports are currently unavailable");
    expect(html).not.toContain("No data yet.");
  });

  it("renders the successful-empty state, distinct from the unavailable UI", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: null },
        student: { data: [], error: null },
        effective_fellowship_thursday: { data: [], error: null },
      })
    );

    const html = await renderPage(createElement(ReportsPage));

    // Successful-but-empty data still renders the normal page's empty states,
    // NOT the unavailable alert.
    expect(html).not.toContain("Reports are currently unavailable");
    expect(html).not.toContain("Refresh reports");
    expect(html).toContain("No data yet.");
    expect(html).toContain("Advising Sessions by Student");
    expect(html).toContain("Advising Sessions by Student and Application/Fellowship");
    expect(html).toContain("Advising Sessions by Fellowship");
  });
});
