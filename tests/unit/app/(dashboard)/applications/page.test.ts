import { createElement } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

vi.mock("@/components/applications/applications-table", () => ({
  ApplicationsTable: () => null,
}));

// ── Functions under test ────────────────────────────────────────────────────

import ApplicationsPage, {
  getApplications,
  getStudents,
  getFellowships,
  ApplicationsUnavailable,
} from "@/app/(dashboard)/applications/page";

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
    from: vi.fn((table: string) => {
      const response = responses[table] ?? { data: [], error: null };
      return {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue(response),
      };
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getApplications ─────────────────────────────────────────────────────────

describe("getApplications", () => {
  it("returns { ok: false } when the query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: null, error: { message: "permission denied" } },
      })
    );

    await expect(getApplications()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the query throws", async () => {
    createServerClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockRejectedValue(new Error("network failure")),
      }),
    } as never);

    await expect(getApplications()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the server client construction throws", async () => {
    // A THROWN construction/request-context error is inside the failure
    // boundary: the loader resolves { ok: false } instead of escaping.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    await expect(getApplications()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, applications: [] } for successful empty data", async () => {
    createServerClient.mockReturnValue(
      createMockClient({ application: { data: [], error: null } })
    );

    const result = await getApplications();

    expect(result).toEqual({ ok: true, applications: [] });
  });
});

// ── getStudents ─────────────────────────────────────────────────────────────

describe("getStudents", () => {
  it("returns { ok: false } when the query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        student: { data: null, error: { message: "db timeout" } },
      })
    );

    await expect(getStudents()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, students: [] } for successful empty data", async () => {
    createServerClient.mockReturnValue(
      createMockClient({ student: { data: [], error: null } })
    );

    await expect(getStudents()).resolves.toEqual({ ok: true, students: [] });
  });

  it("returns { ok: false } when the server client construction throws", async () => {
    // A THROWN construction/request-context error is inside the failure
    // boundary: the loader resolves { ok: false } instead of escaping.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    await expect(getStudents()).resolves.toEqual({ ok: false });
  });
});

// ── getFellowships ──────────────────────────────────────────────────────────

describe("getFellowships", () => {
  it("returns { ok: false } when the query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        fellowship: { data: null, error: { message: "db timeout" } },
      })
    );

    await expect(getFellowships()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, fellowships: [] } for successful empty data", async () => {
    createServerClient.mockReturnValue(
      createMockClient({ fellowship: { data: [], error: null } })
    );

    await expect(getFellowships()).resolves.toEqual({ ok: true, fellowships: [] });
  });

  it("returns { ok: false } when the server client construction throws", async () => {
    // A THROWN construction/request-context error is inside the failure
    // boundary: the loader resolves { ok: false } instead of escaping.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    await expect(getFellowships()).resolves.toEqual({ ok: false });
  });
});

// ── ApplicationsUnavailable ─────────────────────────────────────────────────

describe("ApplicationsUnavailable", () => {
  it("renders accessible unavailable copy", () => {
    const html = renderToString(createElement(ApplicationsUnavailable));

    expect(html).toContain("Applications are currently unavailable");
    expect(html).toContain("Refresh applications");
    expect(html).toContain('role="alert"');
  });
});

// ── ApplicationsPage (page-level failure branch) ────────────────────────────

describe("ApplicationsPage", () => {
  it("renders the unavailable UI when the server client rejects", async () => {
    createServerClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockRejectedValue(new Error("network failure")),
      }),
    } as never);

    const html = await renderPage(
      createElement(ApplicationsPage, { searchParams: Promise.resolve({}) })
    );

    expect(html).toContain("Applications are currently unavailable");
    expect(html).toContain("Refresh applications");
    expect(html).toContain('role="alert"');
  });

  it("renders the unavailable UI when the server client construction throws", async () => {
    // A THROWN client construction (request-context rejection) must render the
    // explicit unavailable state, never an uncaught page error.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope");
    });

    const html = await renderPage(
      createElement(ApplicationsPage, { searchParams: Promise.resolve({}) })
    );

    expect(html).toContain("Applications are currently unavailable");
    expect(html).toContain("Refresh applications");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Pipeline Health");
  });

  it("renders the unavailable UI when any query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: null, error: { message: "permission denied" } },
      })
    );

    const html = await renderPage(
      createElement(ApplicationsPage, { searchParams: Promise.resolve({}) })
    );

    expect(html).toContain("Applications are currently unavailable");
    expect(html).not.toContain("Pipeline Health");
  });

  it("renders the successful-empty state, distinct from the unavailable UI", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application: { data: [], error: null },
        student: { data: [], error: null },
        fellowship: { data: [], error: null },
      })
    );

    const html = await renderPage(
      createElement(ApplicationsPage, { searchParams: Promise.resolve({}) })
    );

    // Successful-but-empty data still renders the normal page's pipeline
    // surface, NOT the unavailable alert.
    expect(html).not.toContain("Applications are currently unavailable");
    expect(html).not.toContain("Refresh applications");
    expect(html).toContain("Pipeline Health");
    expect(html).toContain("Total Applications");
  });
});
