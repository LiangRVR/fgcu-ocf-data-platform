import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Pagination } from "@/components/pagination";

function renderPagination(props: React.ComponentProps<typeof Pagination>) {
  return renderToStaticMarkup(React.createElement(Pagination, props));
}

describe("Pagination", () => {
  it("renders an accessible range, page and page-size options", () => {
    const markup = renderPagination({ page: 1, pageSize: 25, totalCount: 60, totalPages: 3, onPageChange: vi.fn(), onPageSizeChange: vi.fn() });
    expect(markup).toContain("Showing 1–25 of 60");
    expect(markup).toContain("Page 1 of 3");
    expect(markup).toContain('aria-label="Pagination"');
    expect(markup).toContain('aria-label="Rows per page"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("<option value=\"25\" selected=\"\">25</option>");
    expect(markup).toContain('<option value="50">50</option>');
    expect(markup).toContain('<option value="100">100</option>');
  });

  it("renders the exact empty range", () => {
    const markup = renderPagination({ page: 1, pageSize: 50, totalCount: 0, totalPages: 0 });
    expect(markup).toContain("Showing 0–0 of 0");
    expect(markup).toContain("Page 1 of 0");
  });

  it("uses supplied href builders for navigation", () => {
    const markup = renderPagination({ page: 2, pageSize: 25, totalCount: 80, totalPages: 4, getPageHref: (page) => `?page=${page}`, getPageSizeHref: (size) => `?size=${size}` });
    expect(markup).toContain('href="?page=1"');
    expect(markup).toContain('href="?page=3"');
    expect(markup).toContain("Rows per page");
    expect(markup).toContain("<option value=\"25\" selected=\"\">25</option>");
  });
});
