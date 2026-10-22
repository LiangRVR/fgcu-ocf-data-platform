import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/fellowship-thursday",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowserClient: { from: vi.fn(), auth: { getUser: vi.fn() } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FellowshipThursdayTable } from "@/components/fellowship-thursday/fellowship-thursday-table";
import type { FellowshipThursday } from "@/components/fellowship-thursday/fellowship-thursday-list-row";

describe("Fellowship Thursday dated attendance", () => {
  it("renders a valid event date as a date-only calendar value", () => {
    const row = { attendance_id: 4, student_id: 9, attended: true, event_date: "2026-01-02", student: { full_name: "Ada" } } as FellowshipThursday;
    const markup = renderToStaticMarkup(createElement(FellowshipThursdayTable, { initialRecords: [row] }));
    expect(markup).toContain("Event date: January 2, 2026");
  });

  it("labels a null legacy event date as unknown", () => {
    const row = { attendance_id: 4, student_id: 9, attended: true, event_date: null, student: { full_name: "Ada" } } as FellowshipThursday;
    const markup = renderToStaticMarkup(createElement(FellowshipThursdayTable, { initialRecords: [row] }));
    expect(markup).toContain("Unknown (legacy record)");
  });
});
