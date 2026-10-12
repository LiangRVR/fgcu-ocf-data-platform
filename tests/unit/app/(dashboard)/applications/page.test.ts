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
  normalizeApplicationStage,
  normalizeFellowshipIdFilter,
  normalizeCountryFilter,
  normalizeSearchTerm,
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
  responses: Record<string, { data?: unknown; error?: { message: string } | null; count?: number | null }>
) {
  return {
    from: vi.fn((table: string) => {
      const response = responses[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "order", "or", "eq", "ilike", "range", "is"]) {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve);
      return chain;
    }),
  } as never;
}

/**
 * Supabase-like client that records the exact predicate calls (eq/or/ilike) so
 * tests can prove which values reach PostgREST.
 */
function createRecordingClient(
  responses: Record<string, { data?: unknown; error?: { message: string } | null; count?: number | null }> = {},
) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const client = {
    calls,
    from: vi.fn((table: string) => {
      const response = responses[table] ?? { data: [], error: null, count: 0 };
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "order", "or", "eq", "ilike", "range", "is"]) {
        chain[method] = vi.fn((...args: unknown[]) => {
          calls.push({ table, method, args });
          return chain;
        });
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve);
      return chain;
    }),
  };
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getApplications ─────────────────────────────────────────────────────────

describe("getApplications", () => {
  it("returns { ok: false } when the query reports an error", async () => {
    createServerClient.mockReturnValue(
      createMockClient({
        application_list: { data: null, error: { message: "permission denied" } },
      })
    );

    await expect(getApplications()).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the query throws", async () => {
    createServerClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockReturnThis(),
        then: (_resolve: (value: unknown) => unknown, reject: (reason: Error) => unknown) => Promise.reject(new Error("network failure")).then(_resolve, reject),
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

  it("returns count and pagination for successful empty data", async () => {
    createServerClient.mockReturnValue(
      createMockClient({ application_list: { data: [], error: null, count: 0 } })
    );

    const result = await getApplications();

    expect(result).toMatchObject({ ok: true, applications: [], count: 0, pages: 0, pagination: { page: 1, pageSize: 25, offset: 0, to: 24 } });
  });
});

// ── list-criteria allowlisting / normalization ──────────────────────────────

describe("getApplications list-criteria allowlisting", () => {
  it("drops malformed stage/country/fellowship values before PostgREST", async () => {
    const client = createRecordingClient();
    createServerClient.mockReturnValue(client as never);

    await getApplications({ stage: "'; drop table", country: "\u0000bad", fellowship: "abc" });

    expect(client.calls.filter((c) => ["eq", "or", "ilike"].includes(c.method))).toHaveLength(0);
  });

  it("drops `all` and non-allowlisted stage values", async () => {
    const client = createRecordingClient();
    createServerClient.mockReturnValue(client as never);

    await getApplications({ stage: "all" });
    await getApplications({ stage: "Bogus" });

    expect(client.calls.filter((c) => c.method === "eq")).toHaveLength(0);
  });

  it("applies an allowlisted stage, integer fellowship, and trimmed country", async () => {
    const client = createRecordingClient();
    createServerClient.mockReturnValue(client as never);

    await getApplications({ stage: "Awarded", country: "  United States  ", fellowship: "42" });

    const eqs = client.calls.filter((c) => c.method === "eq");
    expect(eqs).toContainEqual({ table: "application_list", method: "eq", args: ["stage_of_application", "Awarded"] });
    expect(eqs).toContainEqual({ table: "application_list", method: "eq", args: ["destination_country", "United States"] });
    expect(eqs).toContainEqual({ table: "application_list", method: "eq", args: ["fellowship_id", 42] });
  });

  it("escapes LIKE wildcards in a literal search term", async () => {
    const client = createRecordingClient();
    createServerClient.mockReturnValue(client as never);

    await getApplications({ search: "a%b_c*d,e(*)" });

    const or = client.calls.find((c) => c.method === "or");
    expect(or).toBeDefined();
    const expression = String(or?.args[0]);
    // LIKE wildcards (including PostgREST's `*`) are escaped; the raw term
    // never appears verbatim.
    expect(expression).toContain("a\\%b\\_c\\*d");
    expect(expression).not.toContain("a%b_c*d");
    expect(expression).not.toContain("e(*)");
  });
});

describe("application criteria normalizers", () => {
  it("allowlists stage values", () => {
    expect(normalizeApplicationStage("Awarded")).toBe("Awarded");
    expect(normalizeApplicationStage("Under Review")).toBe("Under Review");
    expect(normalizeApplicationStage("all")).toBeNull();
    expect(normalizeApplicationStage("Bogus")).toBeNull();
    expect(normalizeApplicationStage(undefined)).toBeNull();
  });

  it("normalizes fellowship ids to positive integers", () => {
    expect(normalizeFellowshipIdFilter("42")).toBe("42");
    expect(normalizeFellowshipIdFilter(" 42 ")).toBe("42");
    expect(normalizeFellowshipIdFilter("-1")).toBeNull();
    expect(normalizeFellowshipIdFilter("0")).toBeNull();
    expect(normalizeFellowshipIdFilter("2.5")).toBeNull();
    expect(normalizeFellowshipIdFilter("abc")).toBeNull();
    expect(normalizeFellowshipIdFilter("999999999999999999999")).toBeNull();
  });

  it("normalizes free-text country filters", () => {
    expect(normalizeCountryFilter("  United States  ")).toBe("United States");
    expect(normalizeCountryFilter("Côte d'Ivoire")).toBe("Côte d'Ivoire");
    expect(normalizeCountryFilter("")).toBeNull();
    expect(normalizeCountryFilter("   ")).toBeNull();
    expect(normalizeCountryFilter("\u0000bad")).toBeNull();
    expect(normalizeCountryFilter("x".repeat(101))).toBeNull();
  });

  it("escapes search grammar and LIKE wildcards", () => {
    expect(normalizeSearchTerm("a%b_c,d(e)")).toBe("a\\%b\\_c d e ");
    expect(normalizeSearchTerm("a*b")).toBe("a\\*b");
    expect(normalizeSearchTerm("*")).toBe("\\*");
    expect(normalizeSearchTerm("  Ada  ")).toBe("Ada");
    expect(normalizeSearchTerm(undefined)).toBe("");
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
  it("loads only the paginated application view during normal list navigation", async () => {
    createServerClient.mockReturnValue(createMockClient({
      application_list: { data: [], error: null, count: 0 },
      student: { data: [], error: null },
      fellowship: { data: [], error: null },
    }));
    await renderPage(createElement(ApplicationsPage, { searchParams: Promise.resolve({}) }));
    const queriedTables = createServerClient.mock.results.flatMap(({ value }) => value.from.mock.calls.map(([table]: [string]) => table));
    expect(queriedTables).toEqual(["application_list"]);
    expect(queriedTables).not.toContain("student");
    expect(queriedTables).not.toContain("fellowship");
  });

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
        application_list: { data: null, error: { message: "permission denied" } },
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
        application_list: { data: [], error: null, count: 0 },
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
