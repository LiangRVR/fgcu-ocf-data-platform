import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  displayRange,
  normalizePage,
  normalizePageSize,
  resolvePagination,
  totalPages,
  updateListSearchParams,
} from "@/lib/utils/pagination";

describe("normalizePage", () => {
  it("defaults missing, empty, and invalid values to page 1", () => {
    expect(normalizePage(undefined)).toBe(1);
    expect(normalizePage(null)).toBe(1);
    expect(normalizePage("")).toBe(1);
    expect(normalizePage("   ")).toBe(1);
    expect(normalizePage("abc")).toBe(1);
    expect(normalizePage({})).toBe(1);
  });

  it("defaults negative, zero, and non-finite values to page 1", () => {
    expect(normalizePage(-5)).toBe(1);
    expect(normalizePage("-1")).toBe(1);
    expect(normalizePage(0)).toBe(1);
    expect(normalizePage("0")).toBe(1);
    expect(normalizePage(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizePage(Number.NaN)).toBe(1);
  });

  it("floors positive fractional values", () => {
    expect(normalizePage(2.9)).toBe(2);
    expect(normalizePage("3.7")).toBe(3);
    expect(normalizePage(0.5)).toBe(1);
  });

  it("parses positive integer strings and numbers", () => {
    expect(normalizePage("4")).toBe(4);
    expect(normalizePage(7)).toBe(7);
  });

  it("caps very large values at a safe integer bound", () => {
    const huge = normalizePage(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(huge)).toBe(true);
    expect(normalizePage(Number.MAX_VALUE)).toBe(huge);
    expect(huge).toBeGreaterThan(0);
  });
});

describe("normalizePageSize", () => {
  it("accepts each allowed page size as a number or string", () => {
    for (const size of PAGE_SIZE_OPTIONS) {
      expect(normalizePageSize(size)).toBe(size);
      expect(normalizePageSize(String(size))).toBe(size);
    }
  });

  it("falls back to the default for missing or invalid values", () => {
    expect(normalizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize("")).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize("abc")).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(-25)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(101)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("floors fractional values before matching the allow-list", () => {
    expect(normalizePageSize(25.9)).toBe(25);
    expect(normalizePageSize("50.4")).toBe(50);
  });
});

describe("resolvePagination", () => {
  it("returns page 1 / pageSize 25 with an inclusive 0-24 range by default", () => {
    expect(resolvePagination()).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
      to: 24,
    });
    expect(resolvePagination(null)).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
      to: 24,
    });
  });

  it("computes an inclusive offset/to pair for a later page", () => {
    expect(resolvePagination({ page: "3", pageSize: "50" })).toEqual({
      page: 3,
      pageSize: 50,
      offset: 100,
      to: 149,
    });
  });

  it("normalizes untrusted inputs before computing the range", () => {
    expect(resolvePagination({ page: "-2", pageSize: "999" })).toEqual({
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
      offset: 0,
      to: 24,
    });
  });

  it("keeps offset and to as safe integers for huge page inputs", () => {
    const { offset, to } = resolvePagination({
      page: Number.MAX_SAFE_INTEGER,
      pageSize: 100,
    });
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(Number.isSafeInteger(to)).toBe(true);
    expect(to).toBe(offset + 99);
  });
});

describe("totalPages", () => {
  it("returns 0 for zero, negative, or invalid totals", () => {
    expect(totalPages(0)).toBe(0);
    expect(totalPages(-10)).toBe(0);
    expect(totalPages(undefined)).toBe(0);
    expect(totalPages("nope")).toBe(0);
  });

  it("rounds up partial pages using the default page size", () => {
    expect(totalPages(1)).toBe(1);
    expect(totalPages(25)).toBe(1);
    expect(totalPages(26)).toBe(2);
    expect(totalPages(100)).toBe(4);
    expect(totalPages(101)).toBe(5);
  });

  it("respects an explicit page size and normalizes invalid sizes", () => {
    expect(totalPages(150, 50)).toBe(3);
    expect(totalPages(150, "100")).toBe(2);
    expect(totalPages(30, 999)).toBe(2);
  });
});

describe("displayRange", () => {
  it("returns 0/0 when there are no rows", () => {
    expect(displayRange({ page: 1, pageSize: 25 }, 0)).toEqual({
      from: 0,
      to: 0,
    });
    expect(displayRange(undefined, -5)).toEqual({ from: 0, to: 0 });
    expect(displayRange(null, "invalid")).toEqual({ from: 0, to: 0 });
  });

  it("returns the first page range", () => {
    expect(displayRange({ page: 1, pageSize: 25 }, 40)).toEqual({
      from: 1,
      to: 25,
    });
  });

  it("returns a middle page range", () => {
    expect(displayRange({ page: 2, pageSize: 25 }, 40)).toEqual({
      from: 26,
      to: 40,
    });
  });

  it("clamps the end to the total on a full last page", () => {
    expect(displayRange({ page: 2, pageSize: 25 }, 50)).toEqual({
      from: 26,
      to: 50,
    });
  });
});

describe("updateListSearchParams", () => {
  it("preserves unrelated keys", () => {
    const params = new URLSearchParams("page=3&pageSize=50&tab=active");
    const next = updateListSearchParams(params, { page: "4" });
    expect(next.get("page")).toBe("4");
    expect(next.get("pageSize")).toBe("50");
    expect(next.get("tab")).toBe("active");
  });

  it("resets page to 1 when search changes", () => {
    const next = updateListSearchParams("page=5&pageSize=50", {
      search: "jane",
    });
    expect(next.get("page")).toBe("1");
    expect(next.get("search")).toBe("jane");
    expect(next.get("pageSize")).toBe("50");
  });

  it("resets page to 1 when filter or sort changes", () => {
    expect(
      updateListSearchParams("page=5", { filter: "active" }).get("page")
    ).toBe("1");
    expect(updateListSearchParams("page=5", { sort: "name" }).get("page")).toBe(
      "1"
    );
  });

  it("does not reset page when only pageSize changes", () => {
    const next = updateListSearchParams("page=5&pageSize=25", {
      pageSize: "100",
    });
    expect(next.get("page")).toBe("5");
    expect(next.get("pageSize")).toBe("100");
  });

  it("clears search/filter/sort values and still resets page", () => {
    const next = updateListSearchParams(
      "page=4&search=old&filter=active&sort=name",
      { search: null, filter: "", sort: undefined }
    );
    expect(next.has("search")).toBe(false);
    expect(next.has("filter")).toBe(false);
    expect(next.has("sort")).toBe(false);
    expect(next.get("page")).toBe("1");
  });

  it("normalizes untrusted page and pageSize patches", () => {
    expect(
      updateListSearchParams("page=2", { page: "-9" }).get("page")
    ).toBe("1");
    expect(
      updateListSearchParams("page=2", { pageSize: "777" }).get("pageSize")
    ).toBe("25");
  });

  it("lets a query change take precedence over an explicit page patch", () => {
    const next = updateListSearchParams("", { search: "x", page: "8" });
    expect(next.get("page")).toBe("1");
    expect(next.get("search")).toBe("x");
  });

  it("accepts a URLSearchParams instance without mutating it", () => {
    const original = new URLSearchParams("page=2&tab=active");
    const next = updateListSearchParams(original, { sort: "date" });
    expect(original.get("page")).toBe("2");
    expect(next.get("page")).toBe("1");
    expect(next.get("sort")).toBe("date");
    expect(next.get("tab")).toBe("active");
  });
});
