import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/advisors",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowserClient: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import AdvisorManagementPage, {
  AdvisorAccountsPanel,
} from "@/app/(dashboard)/advisors/page";

const ADVISOR = {
  advisor_id: 7,
  advisor_name: "Jordan Lee",
  email: "jordan@fgcu.edu",
  role: "Advisor",
  is_active: true,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

function renderPanel(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(AdvisorAccountsPanel, {
      advisors: [],
      meta: { page: 1, pageSize: 25, totalCount: 0, totalPages: 0 },
      loading: false,
      error: null,
      busy: null,
      query: { role: null, active: null },
      onPageChange: vi.fn(),
      onPageSizeChange: vi.fn(),
      onRetry: vi.fn(),
      onRoleChange: vi.fn(),
      onToggleActive: vi.fn(),
      ...overrides,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdvisorAccountsPanel", () => {
  it("renders the loading state while the page is in flight", () => {
    const markup = renderPanel({ loading: true, advisors: [], meta: { page: 1, pageSize: 25, totalCount: 0, totalPages: 0 } });
    expect(markup).toContain("Loading advisor accounts");
  });

  it("renders a failure distinctly from an empty result", () => {
    const markup = renderPanel({ error: "Unable to load advisors." });
    expect(markup).toContain("Advisor list unavailable");
    expect(markup).toContain("Unable to load advisors.");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("No advisor accounts yet");
  });

  it("renders an empty state when there are genuinely zero rows", () => {
    const markup = renderPanel();
    expect(markup).toContain("No advisor accounts yet");
    expect(markup).not.toContain("Advisor list unavailable");
  });

  it("distinguishes a filtered empty result from an empty roster", () => {
    const markup = renderPanel({ query: { role: "Admin", active: null } });
    expect(markup).toContain("No matching advisors");
  });

  it("renders rows and shared pagination metadata", () => {
    const markup = renderPanel({
      advisors: [ADVISOR],
      meta: { page: 1, pageSize: 25, totalCount: 40, totalPages: 2 },
    });
    expect(markup).toContain("Jordan Lee");
    expect(markup).toContain("Showing 1–25 of 40");
    expect(markup).toContain("Page 1 of 2");
    expect(markup).toContain('aria-label="Pagination"');
    expect(markup).toContain("Rows per page");
  });

  it("omits pagination when there are no matching rows", () => {
    const markup = renderPanel();
    expect(markup).not.toContain('aria-label="Pagination"');
  });
});

describe("AdvisorManagementPage", () => {
  it("renders the management shell (provision form + filters) before the async load", () => {
    const markup = renderToStaticMarkup(createElement(AdvisorManagementPage));
    expect(markup).toContain("Advisor Management");
    expect(markup).toContain("Provision an advisor");
    expect(markup).toContain("Search name or email");
  });
});
