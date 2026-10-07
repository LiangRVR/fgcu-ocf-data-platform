import { describe, expect, it } from "vitest";
import { resolvePagination, updateListSearchParams } from "@/lib/utils/pagination";

describe("fellowship list query state", () => {
  it("normalizes page and inclusive Supabase range", () => {
    expect(resolvePagination({ page: "3", pageSize: "50" })).toEqual({ page: 3, pageSize: 50, offset: 100, to: 149 });
  });

  it("resets paging on search/sort while retaining fellowship view context", () => {
    const params = updateListSearchParams("view=archived&page=8&pageSize=50", { search: "climate" });
    expect(params.get("view")).toBe("archived");
    expect(params.get("search")).toBe("climate");
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("50");
  });
});
