/**
 * tests/unit/lib/supabase/errors.test.ts
 *
 * Shared optimistic-concurrency conflict classification. The authoritative
 * stale-version comparison lives in the database writer (SQLSTATE `PT409`);
 * these helpers only classify the PostgREST/supabase-js error shape so API
 * routes and the provisioning adapter can surface the required refresh-and-
 * review guidance (R4) — never a retry or overwrite.
 */
import { describe, expect, it } from "vitest";
import {
  STALE_VERSION_CODE,
  STALE_VERSION_GUIDANCE,
  isVersionConflict,
} from "@/lib/supabase/errors";

describe("STALE_VERSION_CODE", () => {
  it("pinpoints the PostgREST/SQLSTATE code used by the protected writers", () => {
    expect(STALE_VERSION_CODE).toBe("PT409");
  });
});

describe("STALE_VERSION_GUIDANCE", () => {
  it("is the required refresh-and-review instruction (R4), not a raw error", () => {
    expect(STALE_VERSION_GUIDANCE).toContain("Refresh and review");
    expect(STALE_VERSION_GUIDANCE).not.toContain("SQLSTATE");
  });
});

describe("isVersionConflict", () => {
  it("classifies a supabase-js/PostgREST error carrying the PT409 code", () => {
    expect(isVersionConflict({ code: "PT409" })).toBe(true);
    expect(
      isVersionConflict({
        code: "PT409",
        message: "version conflict on row",
        hint: "refresh and try again",
      })
    ).toBe(true);
  });

  it("ignores the message text entirely (classification is by code only)", () => {
    // A message that merely mentions PT409/conflict is NOT a conflict; only a
    // top-level string `code === "PT409"` is authoritative.
    expect(isVersionConflict({ message: "PT409 version conflict" })).toBe(false);
    expect(isVersionConflict({ code: undefined, message: "PT409" })).toBe(false);
  });

  it("does not confuse other SQLSTATE codes (P0002, 22023, 42501) with a stale version", () => {
    expect(isVersionConflict({ code: "P0002", message: "row not found" })).toBe(false);
    expect(isVersionConflict({ code: "22023", message: "invalid parameter" })).toBe(false);
    expect(isVersionConflict({ code: "42501", message: "permission denied" })).toBe(false);
  });

  it("returns false for null, undefined, and non-object errors", () => {
    expect(isVersionConflict(null)).toBe(false);
    expect(isVersionConflict(undefined)).toBe(false);
    expect(isVersionConflict("PT409")).toBe(false);
    expect(isVersionConflict(409)).toBe(false);
  });

  it("returns false when the code is not a string (e.g. a nested/renamed error)", () => {
    expect(isVersionConflict({ code: 409 })).toBe(false);
    expect(isVersionConflict({ code: ["PT409"] })).toBe(false);
    expect(isVersionConflict({})).toBe(false);
  });
});