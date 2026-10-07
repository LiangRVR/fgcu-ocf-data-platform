import { describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────
// `recoverStaleApplication` is pure, but it lives in the client table module,
// so the module's client-only imports are stubbed to keep this a node-lane
// unit test with no DOM/runtime dependency.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
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

import {
  GENERAL_ADVISING_VALUE,
  recoverStaleApplication,
} from "@/components/advising/advising-table";

type AddFormState = Parameters<typeof recoverStaleApplication>[0];

function form(overrides: Partial<AddFormState> = {}): AddFormState {
  return {
    student_id: "42",
    advisor_id: "7",
    application_id: "99",
    meeting_date: "2026-09-23",
    meeting_mode: "In-Person",
    no_show: false,
    notes: "Stale application regression",
    ...overrides,
  } as AddFormState;
}

describe("recoverStaleApplication", () => {
  it("resets the selection to General Advising", () => {
    const { form: recovered } = recoverStaleApplication(form(), 0);

    expect(recovered.application_id).toBe(GENERAL_ADVISING_VALUE);
    expect(recovered.application_id).not.toBe("99");
  });

  it("invalidates the application option cache so the open dialog refetches", () => {
    // The deleted application must be dropped from the still-open dropdown, so
    // recovery has to bump the reload key, not only reset the selection.
    const { applicationsReloadKey } = recoverStaleApplication(form(), 3);

    expect(applicationsReloadKey).toBe(4);
  });

  it("preserves the student, advisor, and other form fields", () => {
    const { form: recovered } = recoverStaleApplication(
      form({ student_id: "42", advisor_id: "7", meeting_mode: "Virtual", no_show: true }),
      0,
    );

    expect(recovered).toMatchObject({
      student_id: "42",
      advisor_id: "7",
      application_id: GENERAL_ADVISING_VALUE,
      meeting_date: "2026-09-23",
      meeting_mode: "Virtual",
      no_show: true,
      notes: "Stale application regression",
    });
  });
});
