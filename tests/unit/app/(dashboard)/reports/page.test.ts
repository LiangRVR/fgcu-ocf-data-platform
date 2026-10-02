import { createElement } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient, selectedQueries } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  selectedQueries: [] as Array<{ table: string; columns: string }>,
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
        return Promise.resolve(responses[table] ?? { data: [], error: null });
      }),
    })),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectedQueries.length = 0;
});

// ── getReportsData ──────────────────────────────────────────────────────────

describe("getReportsData", () => {
  it("returns { ok: false } when any underlying query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        advising_meeting: { data: [], error: { message: "db timeout" } },
        student: { data: [], error: null },
        fellowship_thursday: { data: [], error: null },
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
        fellowship_thursday: { data: [], error: null },
      })
    );

    const result = await getReportsData();

    const meetingQuery = selectedQueries.find(({ table }) => table === "advising_meeting");
    expect(meetingQuery?.columns).toContain("application_id");
    expect(meetingQuery?.columns).toContain("application!advising_meeting_application_id_fkey");
    expect(meetingQuery?.columns).toContain("fellowship(fellowship_name)");

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
        fellowship_thursday: { data: [], error: null },
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
        fellowship_thursday: { data: [], error: null },
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
