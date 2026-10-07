import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADVISOR_DIRECTION,
  DEFAULT_ADVISOR_SORT,
  applyAdvisorQueryPatch,
  canonicalAdvisorSearchParams,
  parseAdvisorListQuery,
  toAdvisorSearchParams,
} from "@/app/(dashboard)/advisors/query";

describe("parseAdvisorListQuery", () => {
  it("normalizes missing state to safe defaults", () => {
    expect(parseAdvisorListQuery()).toEqual({
      page: 1,
      pageSize: 25,
      search: "",
      active: null,
      role: null,
      sort: DEFAULT_ADVISOR_SORT,
      direction: DEFAULT_ADVISOR_DIRECTION,
    });
  });

  it("normalizes untrusted page/pageSize and accepts allowlisted state", () => {
    const parsed = parseAdvisorListQuery(
      "page=3.9&pageSize=100&search=%20Jane%20&active=active&role=Admin&sort=email&direction=desc"
    );
    expect(parsed).toEqual({
      page: 3,
      pageSize: 100,
      search: "Jane",
      active: true,
      role: "Admin",
      sort: "email",
      direction: "desc",
    });
  });

  it("rejects invalid/unsafe values instead of forwarding them", () => {
    const parsed = parseAdvisorListQuery(
      "page=-1&pageSize=1000&active=maybe&role=Superuser&sort=email;drop%20table&direction=sideways"
    );
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(25);
    expect(parsed.active).toBeNull();
    expect(parsed.role).toBeNull();
    expect(parsed.sort).toBe(DEFAULT_ADVISOR_SORT);
    expect(parsed.direction).toBe(DEFAULT_ADVISOR_DIRECTION);
  });

  it("accepts record-style searchParams and caps the search length", () => {
    const parsed = parseAdvisorListQuery({
      search: ["x".repeat(500)],
      active: "false",
      role: "Advisor",
    });
    expect(parsed.search).toHaveLength(100);
    expect(parsed.active).toBe(false);
    expect(parsed.role).toBe("Advisor");
  });
});

describe("toAdvisorSearchParams", () => {
  it("always includes page/pageSize and omits defaults", () => {
    const params = toAdvisorSearchParams({
      page: 1,
      pageSize: 25,
      search: "",
      active: null,
      role: null,
      sort: DEFAULT_ADVISOR_SORT,
      direction: DEFAULT_ADVISOR_DIRECTION,
    });
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("25");
    expect(params.has("search")).toBe(false);
    expect(params.has("active")).toBe(false);
    expect(params.has("role")).toBe(false);
    expect(params.has("sort")).toBe(false);
    expect(params.has("direction")).toBe(false);
  });

  it("serializes non-default filters and sort state", () => {
    const params = toAdvisorSearchParams({
      page: 2,
      pageSize: 50,
      search: "jane",
      active: false,
      role: "Advisor",
      sort: "email",
      direction: "desc",
    });
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("50");
    expect(params.get("search")).toBe("jane");
    expect(params.get("active")).toBe("false");
    expect(params.get("role")).toBe("Advisor");
    expect(params.get("sort")).toBe("email");
    expect(params.get("direction")).toBe("desc");
  });
});

describe("applyAdvisorQueryPatch", () => {
  it("resets to page 1 when the search changes and preserves unrelated keys", () => {
    const next = applyAdvisorQueryPatch("page=4&pageSize=50&tab=active", {
      search: "jane",
    });
    expect(next.get("page")).toBe("1");
    expect(next.get("pageSize")).toBe("50");
    expect(next.get("search")).toBe("jane");
    expect(next.get("tab")).toBe("active");
  });

  it("resets to page 1 when the active or role filter changes", () => {
    expect(applyAdvisorQueryPatch("page=4", { active: true }).get("page")).toBe("1");
    expect(applyAdvisorQueryPatch("page=4", { role: "Admin" }).get("page")).toBe("1");
  });

  it("resets to page 1 when the page size changes", () => {
    const next = applyAdvisorQueryPatch("page=4&pageSize=25", { pageSize: "100" });
    expect(next.get("page")).toBe("1");
    expect(next.get("pageSize")).toBe("100");
  });

  it("preserves the page for a bare page change", () => {
    const next = applyAdvisorQueryPatch("page=1&pageSize=25", { page: "3" });
    expect(next.get("page")).toBe("3");
  });

  it("clears filter values and normalizes untrusted input", () => {
    const next = applyAdvisorQueryPatch("page=4&active=true&role=Admin", {
      active: null,
      role: null,
      pageSize: "999",
    });
    expect(next.has("active")).toBe(false);
    expect(next.has("role")).toBe(false);
    expect(next.get("pageSize")).toBe("25");
    expect(next.get("page")).toBe("1");
  });
});

describe("canonicalAdvisorSearchParams", () => {
  it("leaves a clean URL untouched", () => {
    expect(canonicalAdvisorSearchParams("page=2&pageSize=50").toString()).toBe(
      "page=2&pageSize=50"
    );
  });

  it("drops malformed known keys but preserves unrelated context", () => {
    const next = canonicalAdvisorSearchParams(
      "page=0&pageSize=777&role=Superuser&active=maybe&sort=bad&direction=bad&tab=active"
    );
    expect(next.toString()).toBe("tab=active");
  });

  it("canonicalizes an out-of-range page to the supplied valid page", () => {
    const next = canonicalAdvisorSearchParams("page=99", { page: 2 });
    expect(next.get("page")).toBe("2");
  });

  it("removes an invalid zero-result page when resolving to page 1", () => {
    const next = canonicalAdvisorSearchParams("page=99&pageSize=50", { page: 1 });
    expect(next.has("page")).toBe(false);
    expect(next.get("pageSize")).toBe("50");
  });
});
