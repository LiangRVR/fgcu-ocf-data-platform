import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/scholarship-history",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowserClient: {
    from: vi.fn(),
    auth: { getUser: vi.fn() },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ScholarshipHistoryTable } from "@/components/scholarship-history/scholarship-history-table";

type Record = Parameters<typeof ScholarshipHistoryTable>[0]["initialRecords"][number];

function record(overrides: Partial<Record>): Record {
  return {
    history_id: 1,
    student_id: 10,
    fellowship_id: 100,
    base_fellowship_id: 100,
    has_correction: false,
    is_voided: false,
    voided_at: null,
    student_name: "Ada Lovelace",
    fellowship_name: "OCF Fellowship",
    student: { full_name: "Ada Lovelace" },
    fellowship: { fellowship_name: "OCF Fellowship" },
    effective: {
      history_id: 1,
      fellowship_id: 100,
      has_correction: false,
      is_voided: false,
    },
    amendments: [],
    ...overrides,
  } as Record;
}

function render(props: Partial<Parameters<typeof ScholarshipHistoryTable>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ScholarshipHistoryTable, {
      initialRecords: [],
      totalCount: 0,
      totalPages: 0,
      currentPage: 1,
      currentPageSize: 25,
      ...props,
    }),
  );
}

describe("ScholarshipHistoryTable", () => {
  it("renders every server-provided record without client-side filtering", () => {
    // The server already filtered to the page; the component must not narrow
    // the rows it was handed.
    const markup = render({
      initialRecords: [
        record({ history_id: 1, student_id: 10, student_name: "Ada Lovelace", student: { full_name: "Ada Lovelace" } }),
        record({ history_id: 2, student_id: 11, student_name: "Grace Hopper", student: { full_name: "Grace Hopper" } }),
      ],
      totalCount: 2,
      totalPages: 1,
    });

    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("Grace Hopper");
  });

  it("renders the shared pagination control from the server page metadata", () => {
    const markup = render({
      initialRecords: [record({})],
      totalCount: 60,
      totalPages: 3,
      currentPage: 1,
      currentPageSize: 25,
    });

    expect(markup).toContain('aria-label="Pagination"');
    expect(markup).toContain("Showing 1–25 of 60");
    expect(markup).toContain("Page 1 of 3");
    expect(markup).toContain('aria-label="Rows per page"');
  });

  it("renders the bounded amendment trail supplied by the server loader", () => {
    const markup = render({
      initialRecords: [
        record({
          amendments: [
            {
              amendment_id: 7,
              history_id: 1,
              amendment_type: "Correction",
              corrected_fellowship_id: 100,
              created_at: "2026-10-02T00:00:00.000Z",
              created_by_advisor_id: 2,
              details: null,
              reason: "Program recorded incorrectly",
              fellowship: { fellowship_name: "OCF Fellowship" },
            },
          ],
          has_correction: true,
          effective: { history_id: 1, fellowship_id: 100, has_correction: true, is_voided: false },
        }),
      ],
      totalCount: 1,
      totalPages: 1,
    });

    expect(markup).toContain("Program recorded incorrectly");
    expect(markup).toContain("Correction");
    expect(markup).toContain("1 amendment");
  });

  it("renders the deferred bounded fellowship filter lookup control", () => {
    // The fellowship filter is a bounded typeahead, not an eager selector list:
    // only the search affordance renders before the user types.
    const markup = render();

    expect(markup).toContain('aria-label="Filter by fellowship"');
    expect(markup).toContain("Filter by fellowship…");
  });

  it("keeps a voided award auditable and hides further amendment actions", () => {
    const markup = render({
      initialRecords: [
        record({
          is_voided: true,
          effective: { history_id: 1, fellowship_id: 100, has_correction: false, is_voided: true },
        }),
      ],
      totalCount: 1,
      totalPages: 1,
    });

    expect(markup).toContain("Voided award");
    expect(markup).not.toContain("Void Award Record");
  });
});
