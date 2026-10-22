import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

const { requireAdvisor } = vi.hoisted(() => ({
  requireAdvisor: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAdvisor,
}));

// The client AdvisingTable is mocked to a passthrough that renders the
// display contracts this unit suite owns on the server-data side:
//   - meeting context: NULL application_id → "General Advising"; a known
//     application → the cycle-aware "{fellowship} — {year}" label;
//   - append-only provenance: the recorder is passed through, with a clear
//     legacy fallback when older records have no creator;
//   - attached corrections: amendments arrive as a chronological collection
//     with their creator attribution intact, and the server payload never
//     carries a meeting ID, creator, or timestamp input;
//   - selector options are loaded lazily by the client table when a selector
//     is opened, rather than supplied during the page render.
// The mock mirrors exactly what the production table renders (the interaction
// half — student-change refresh, option filtering, stale-selection clearing,
// correction form submission — is exercised by the E2E lane). The label
// wording is asserted literally here and unit-tested in depth against the real
// helper in tests/unit/lib/applications/pipeline.test.ts.
vi.mock("@/components/advising/advising-table", async () => {
  const { createElement: ce } = await import("react");
  const GENERAL_ADVISING = "General Advising";
  const cycleLabel = (
    fellowship: string | null | undefined,
    year: number | null | undefined
  ): string => {
    if (!fellowship && !year) return "Unknown application";
    if (!fellowship) return `Unknown fellowship — ${year}`;
    if (!year) return `${fellowship} — year unknown`;
    return `${fellowship} — ${year}`;
  };
  return {
    AdvisingTable: ({
      initialMeetings,
    }: {
      initialMeetings: Array<{
        student_id: number;
        application_id: number | null;
        created_at?: string | null;
        recorded_by?: { advisor_name: string } | null;
        application?: {
          application_year: number | null;
          fellowship: { fellowship_name: string } | null;
        } | null;
        amendments?: Array<{
          amendment_id: number;
          meeting_id: number;
          reason: string;
          details: string;
          created_at: string;
          created_by_advisor_id: number;
          created_by?: { advisor_name: string } | null;
        }>;
      }>;
    }) =>
      ce(
        "div",
        { "data-testid": "advising-table" },
        ce(
          "ul",
          { className: "meeting-contexts" },
          initialMeetings.map((meeting) =>
            ce(
              "li",
              { key: meeting.student_id, className: "meeting-context" },
              meeting.application_id == null
                ? GENERAL_ADVISING
                : cycleLabel(
                    meeting.application?.fellowship?.fellowship_name,
                    meeting.application?.application_year
                  )
            )
          )
        ),
        ce(
          "ul",
          { className: "meeting-provenance" },
          initialMeetings.map((meeting) =>
            ce(
              "li",
              { key: `provenance-${meeting.student_id}` },
              `Recorded by ${meeting.recorded_by?.advisor_name ?? "Unknown (legacy record)"} · Recorded ${meeting.created_at ?? "date unavailable"}`
            )
          )
        ),
        ce(
          "ul",
          { className: "meeting-corrections" },
          initialMeetings.flatMap((meeting) =>
            (meeting.amendments ?? []).map((amendment) =>
              ce(
                "li",
                {
                  key: `amendment-${amendment.amendment_id}`,
                  className: "meeting-correction",
                },
                `${amendment.reason} :: ${amendment.details} :: Added by ${amendment.created_by?.advisor_name ?? "Unknown advisor"} :: ${amendment.created_at}`
              )
            )
          )
        ),
      ),
  };
});

// ── Functions under test ────────────────────────────────────────────────────

import AdvisingPage from "@/app/(dashboard)/advising/page";

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

/** SSR inserts `<!-- -->` between adjacent text nodes; collapse them so
 * `expect(html).toContain("N meetings")` matches the rendered badge text. */
function normalizeSsr(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

/**
 * The advising page's list loader chains every PostgREST builder method the
 * production client exposes for this surface — `select`, `or`, `eq`, `order`,
 * `in`, and the inclusive `range` — then awaits the chain for `{data, error,
 * count}`. The mock keeps the same chain object for every fluent call AND makes
 * it thenable, so `await chain` resolves to the per-table response regardless of
 * how many intermediate calls the page issued. `count` is threaded through so
 * the exact-count/pagination contract is exercised, not stubbed to zero.
 */
function createMockClient(
  responses: Record<
    string,
    { data?: unknown; error?: { message: string } | null; count?: number }
  >
) {
  return {
    from: vi.fn((table: string) => {
      const response = responses[table] ?? { data: [], error: null, count: 0 };
      const chain: {
        select: ReturnType<typeof vi.fn>;
        or: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        in: ReturnType<typeof vi.fn>;
        order: ReturnType<typeof vi.fn>;
        range: ReturnType<typeof vi.fn>;
        then: (resolve: (value: unknown) => void) => void;
      } = {
        select: vi.fn(),
        or: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        order: vi.fn(),
        range: vi.fn(),
        then: (resolve) => resolve(response),
      };
      chain.select.mockReturnValue(chain);
      chain.or.mockReturnValue(chain);
      chain.eq.mockReturnValue(chain);
      chain.in.mockReturnValue(chain);
      chain.order.mockReturnValue(chain);
      chain.range.mockReturnValue(chain);
      return chain;
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdvisor.mockResolvedValue({ advisor_id: 1 });
});

// ── AdvisingPage (page-level rendering) ─────────────────────────────────────

describe("AdvisingPage", () => {
  it("loads the normal meeting list without querying selector tables", async () => {
    const client = createMockClient({
      advising_meeting_list: { data: [], count: 0, error: null },
    }) as unknown as { from: ReturnType<typeof vi.fn> };
    createServerClient.mockReturnValue(client);

    await renderPage(
      createElement(AdvisingPage, {
        searchParams: Promise.resolve({ page: "1", pageSize: "25" }),
      })
    );

    const queriedTables = client.from.mock.calls.map((call) => call[0]);
    expect(queriedTables).toContain("advising_meeting_list");
    expect(queriedTables).not.toContain("student");
    expect(queriedTables).not.toContain("advisor");
    expect(queriedTables).not.toContain("application");
    // No meeting rows means there is no amendments query either. Selector
    // options remain the table's existing typeahead flow, not page-load data.
    expect(queriedTables).toEqual(["advising_meeting_list"]);
  });

  it("renders General Advising for a null-application meeting and the cycle label for an application-bound meeting", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        // The list loader reads the flattened SECURITY INVOKER view, not the
        // base table with embedded relations.
        advising_meeting_list: {
          data: [
            // General Advising: application_id NULL → NULL application context.
            {
              meeting_id: 1,
              student_id: 10,
              advisor_id: 1,
              application_id: null,
              meeting_date: "2026-09-01",
              meeting_mode: "In-Person",
              no_show: false,
              notes: "Intro session",
              created_at: "2026-09-01T12:00:00.000Z",
              created_by_advisor_id: null,
              student_name: "Ada Lovelace",
              advisor_name: "Grace Hopper",
              recorded_by_advisor_name: null,
              application_year: null,
              fellowship_id: null,
              fellowship_name: null,
            },
            // Application-bound advising: the flattened view resolves the cycle.
            {
              meeting_id: 2,
              student_id: 10,
              advisor_id: 1,
              application_id: 7,
              meeting_date: "2026-09-15",
              meeting_mode: "Virtual",
              no_show: false,
              notes: null,
              created_at: "2026-09-15T12:00:00.000Z",
              created_by_advisor_id: 3,
              student_name: "Ada Lovelace",
              advisor_name: "Grace Hopper",
              recorded_by_advisor_name: "Grace Hopper",
              application_year: 2026,
              fellowship_id: 3,
              fellowship_name: "Fulbright",
            },
          ],
          count: 2,
          error: null,
        },
        // Amendments arrive in a deliberately scrambled order from the second,
        // bounded query: the loader must group by meeting and restore
        // chronological (created_at ASC, amendment_id ASC) order.
        advising_meeting_amendment: {
          data: [
            {
              amendment_id: 9002,
              meeting_id: 1,
              reason: "Same timestamp — higher id",
              details: "Same created_at as 9001; amendment_id sorts it last.",
              created_at: "2026-09-02T09:30:00.000Z",
              created_by_advisor_id: 2,
              created_by: { advisor_name: "Alan Turing" },
            },
            {
              amendment_id: 9003,
              meeting_id: 1,
              reason: "Earliest correction",
              details: "Correction recorded before the others on this meeting.",
              created_at: "2026-09-02T08:00:00.000Z",
              created_by_advisor_id: 3,
              created_by: { advisor_name: "Margaret Hamilton" },
            },
            {
              amendment_id: 9001,
              meeting_id: 1,
              reason: "Same timestamp — lower id",
              details: "Tie-broken by amendment_id ascending.",
              created_at: "2026-09-02T09:30:00.000Z",
              created_by_advisor_id: 2,
              created_by: { advisor_name: "Alan Turing" },
            },
          ],
          error: null,
        },
        student: {
          data: [{ student_id: 10, full_name: "Ada Lovelace" }],
          error: null,
        },
        advisor: { data: [{ advisor_id: 1, advisor_name: "Grace Hopper" }], error: null },
        application: {
          data: [
            {
              application_id: 8,
              student_id: 10,
              application_year: 2026,
              fellowship: { fellowship_name: "Fulbright" },
            },
            {
              application_id: 9,
              student_id: 10,
              application_year: 2025,
              fellowship: { fellowship_name: "Fulbright" },
            },
          ],
          error: null,
        },
      })
    );

    const html = await renderPage(
      createElement(AdvisingPage, { searchParams: Promise.resolve({}) })
    );

    // Null application_id displays as General Advising — never a guessed label.
    expect(html).toContain("General Advising");
    // Application-bound meeting renders the cycle-aware label.
    expect(html).toContain("Fulbright — 2026");
    // Selector options are lazily loaded by the client table, not server-rendered.
    expect(html).not.toContain("application-options");
    // The page passes provenance through for new records and makes legacy
    // records without a creator explicit rather than inventing one.
    expect(html).toContain("Recorded by Grace Hopper");
    expect(html).toContain("Recorded by Unknown (legacy record)");
    // The embedded amendment collection flows through with its reason,
    // details, creator attribution, and database-authored timestamp intact.
    expect(html).toContain("Earliest correction");
    expect(html).toContain("Correction recorded before the others on this meeting.");
    expect(html).toContain("Added by Margaret Hamilton");
    expect(html).toContain("Added by Alan Turing");
    expect(html).toContain("2026-09-02T08:00:00.000Z");
    expect(html).toContain("2026-09-02T09:30:00.000Z");
    // Multiple amendments are restored to chronological order by the bounded
    // loader query even though the mock returned them scrambled: 9003 (earliest
    // created_at) appears before 9001 (same created_at as 9002, sorted first by
    // amendment_id), which appears before 9002.
    const earliest = html.indexOf("Earliest correction");
    const lowerId = html.indexOf("Same timestamp — lower id");
    const higherId = html.indexOf("Same timestamp — higher id");
    expect(earliest).toBeGreaterThan(-1);
    expect(lowerId).toBeGreaterThan(earliest);
    expect(higherId).toBeGreaterThan(lowerId);
    // The original meeting's meeting_id / amendment_id / creator / timestamp
    // are never re-exposed as editable fields by the page.
    expect(html).not.toContain("name=\"meeting_id\"");
    expect(html).not.toContain("name=\"amendment_id\"");
    expect(html).not.toContain("name=\"created_by_advisor_id\"");
    expect(html).not.toContain("name=\"created_at\"");
    // Both meetings counted (the badge text collapses SSR comment nodes).
    expect(normalizeSsr(html)).toContain("2 meetings");
  });

  it("searches only allowlisted list-view columns and pages with an inclusive range", async () => {
    const client = createMockClient({
      // 60 rows → 3 pages at the default page size, so page 2 is in range and
      // the loader does not canonicalize-redirect.
      advising_meeting_list: { data: [], count: 60, error: null },
    }) as unknown as { from: ReturnType<typeof vi.fn> };
    createServerClient.mockReturnValue(client);

    await renderPage(
      createElement(AdvisingPage, {
        searchParams: Promise.resolve({ search: "Ada Turing", page: "2", pageSize: "25" }),
      })
    );

    // The loader must read the flattened list view, never the base table or a
    // non-existent `search_document` field, and never PostgREST `textSearch`.
    const fromCalls = client.from.mock.calls.map((call) => call[0]);
    expect(fromCalls[0]).toBe("advising_meeting_list");
    expect(fromCalls).not.toContain("advising_meeting");

    // The mock chain intentionally exposes no `textSearch`, so a regression to
    // the non-existent full-text column would throw here rather than pass.
    const listChain = client.from.mock.results[0].value as {
      or: ReturnType<typeof vi.fn>;
      range: ReturnType<typeof vi.fn>;
    };
    expect(listChain.or).toHaveBeenCalledTimes(1);
    const orExpression = listChain.or.mock.calls[0][0] as string;
    for (const field of [
      "student_name",
      "advisor_name",
      "notes",
      "meeting_mode",
      "fellowship_name",
    ]) {
      expect(orExpression).toContain(`${field}.ilike.*Ada Turing*`);
    }
    expect(orExpression).not.toContain("search_document");
    // Page 2 of 25 → inclusive [25, 49].
    expect(listChain.range).toHaveBeenCalledWith(25, 49);
  });

  it("renders the page shell (zero counts) when a query fails instead of crashing", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        advising_meeting_list: { data: null, error: { message: "db timeout" } },
        student: {
          data: [{ student_id: 10, full_name: "Ada Lovelace" }],
          error: null,
        },
        advisor: { data: [{ advisor_id: 1, advisor_name: "Grace Hopper" }], error: null },
        application: { data: [], error: null },
      })
    );

    const html = await renderPage(
      createElement(AdvisingPage, { searchParams: Promise.resolve({}) })
    );

    expect(html).toContain("Advising");
    // No meetings → no meeting contexts, and the coverage section still renders.
    expect(html).not.toContain("General Advising");
    expect(normalizeSsr(html)).toContain("0 meetings");
    expect(html).toContain("Advising Coverage");
  });
});
