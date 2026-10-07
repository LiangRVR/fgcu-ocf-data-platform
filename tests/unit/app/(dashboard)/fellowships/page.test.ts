import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/components/fellowships/fellowships-table",
  () => ({ FellowshipsTable: () => null })
);
vi.mock(
  "@/components/fellowships/add-fellowship-button",
  () => ({ AddFellowshipButton: () => null })
);

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

vi.mock("next/navigation", () => ({
  redirect: (href: string): never => {
    throw new Error(`REDIRECT:${href}`);
  },
}));

import FellowshipsPage from "@/app/(dashboard)/fellowships/page";

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

function makeClient(result: QueryResult) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const op of ["select", "not", "is", "eq", "ilike", "order"]) {
    builder[op] = (...args) => {
      calls.push({ op, args });
      return builder;
    };
  }
  builder.range = (...args) => {
    calls.push({ op: "range", args });
    return Promise.resolve(result);
  };

  return {
    client: { from: vi.fn().mockReturnValue(builder) },
    calls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FellowshipsPage canonicalization", () => {
  it("canonicalizes a zero-result page>1 to page 1 without a replacement query", async () => {
    const { client, calls } = makeClient({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    await expect(
      FellowshipsPage({ searchParams: Promise.resolve({ page: "5" }) })
    ).rejects.toThrow("REDIRECT:/fellowships");

    // The single bounded range query is the whole cost; no second fetch runs.
    expect(calls.filter((c) => c.op === "range")).toHaveLength(1);
  });

  it("canonicalizes a normal out-of-range page to the last valid page", async () => {
    const { client, calls } = makeClient({ data: [], error: null, count: 30 });
    createServerClient.mockReturnValue(client);

    await expect(
      FellowshipsPage({
        searchParams: Promise.resolve({ view: "archived", page: "5" }),
      })
    ).rejects.toThrow("REDIRECT:/fellowships?view=archived&page=2");

    expect(calls.filter((c) => c.op === "range")).toHaveLength(1);
  });

  it("renders a canonical zero-result page 1 without redirecting", async () => {
    const { client } = makeClient({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    const markup = renderToStaticMarkup(
      await FellowshipsPage({ searchParams: Promise.resolve({}) })
    );

    expect(markup).toContain("Fellowships");
  });
});
