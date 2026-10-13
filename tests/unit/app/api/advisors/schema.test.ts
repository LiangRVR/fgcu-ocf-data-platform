/**
 * tests/unit/app/api/advisors/schema.test.ts
 *
 * Contract for the protected advisor-management UPDATE schema:
 *
 *   - exactly ONE mutation per request: `role` XOR `isActive` XOR
 *     `advisorName` (any combined payload rejects fail-closed with 400);
 *   - `reason` is REQUIRED only for the privileged role / active-state
 *     mutations; advisor-name edits are ordinary profile edits (R8) and need
 *     no reason;
 *   - `expectedVersion` (the caller's loaded `advisor.row_version`) is
 *     REQUIRED for every mutation — the versioned writers reject a stale
 *     value with `PT409`, so a stale admin form can never overwrite newer
 *     work; malformed values (missing/zero/negative/non-integer/non-number)
 *     fail closed before any state change;
 *   - `email` and unknown keys — `auth_user_id`, client actor fields — are
 *     rejected fail-closed (strict object): email is read-only (R4) and actor
 *     identity is never a payload field.
 */
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("@/lib/auth/session", () => ({
  ADVISOR_ROLES: ["Admin", "Advisor"] as const,
}));

import { updateAdvisorSchema } from "@/app/api/advisors/schema";

function messages(result: { success: boolean; error?: z.ZodError }): string[] {
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

function paths(result: { success: boolean; error?: z.ZodError }): PropertyKey[][] {
  return result.success ? [] : result.error!.issues.map((issue) => issue.path);
}

describe("updateAdvisorSchema", () => {
  it("accepts an advisorName-only update WITHOUT a reason (ordinary profile edit, R8)", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name", expectedVersion: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ advisorName: "New Name", expectedVersion: 2 });
      expect(result.data.reason).toBeUndefined();
      expect(result.data.role).toBeUndefined();
      expect(result.data.isActive).toBeUndefined();
    }
  });

  it("trims the advisor name before accepting it", () => {
    const result = updateAdvisorSchema.safeParse({
      advisorName: "  Ada  Lovelace ",
      expectedVersion: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.advisorName).toBe("Ada  Lovelace");
    }
  });

  it("accepts a role change with a non-blank reason and the loaded expected version", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Admin",
      reason: "Promotion",
      expectedVersion: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ role: "Admin", reason: "Promotion", expectedVersion: 4 });
    }
  });

  it("accepts an active-state change with a non-blank reason and the loaded expected version", () => {
    const result = updateAdvisorSchema.safeParse({
      isActive: false,
      reason: "Leaving team",
      expectedVersion: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ isActive: false, reason: "Leaving team", expectedVersion: 4 });
    }
  });

  it("rejects an empty payload (nothing to update)", () => {
    const result = updateAdvisorSchema.safeParse({ expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Provide role, isActive, or advisorName to update an advisor."
    );
  });

  it("rejects a blank advisor name", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "   ", expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["advisorName"]);
  });

  it("rejects an advisor name shorter than 2 characters", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "A", expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Name must be at least 2 characters");
    expect(paths(result)).toContainEqual(["advisorName"]);
  });

  it("rejects an advisor name longer than 120 characters", () => {
    const result = updateAdvisorSchema.safeParse({
      advisorName: "A".repeat(121),
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Name must be 120 characters or fewer");
  });

  it("rejects a MISSING reason for a role change (required non-blank reason)", () => {
    const result = updateAdvisorSchema.safeParse({ role: "Admin", expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A reason is required.");
    expect(paths(result)).toContainEqual(["reason"]);
  });

  it("rejects a MISSING reason for an active-state change", () => {
    const result = updateAdvisorSchema.safeParse({ isActive: false, expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A reason is required.");
    expect(paths(result)).toContainEqual(["reason"]);
  });

  it("rejects a BLANK reason for a role change", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Admin",
      reason: "   \n  ",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A reason is required.");
    expect(paths(result)).toContainEqual(["reason"]);
  });

  it("rejects a reason longer than 500 characters", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Admin",
      reason: "R".repeat(501),
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Reason must be 500 characters or fewer");
  });

  it("rejects an invalid role value", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Superuser",
      reason: "Why",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["role"]);
  });

  it("rejects a non-boolean isActive value", () => {
    const result = updateAdvisorSchema.safeParse({
      isActive: "yes",
      reason: "Why",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["isActive"]);
  });

  it("rejects a non-string advisorName value", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: 42, expectedVersion: 2 });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["advisorName"]);
  });

  // ── expectedVersion contract (optimistic concurrency) ────────────────────

  it("rejects a MISSING expectedVersion (stale writes must fail closed)", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name" });
    expect(result.success).toBe(false);
    // Zod reports the missing required field at the expectedVersion path.
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a ZERO expectedVersion", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name", expectedVersion: 0 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A valid row version is required.");
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a NEGATIVE expectedVersion", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name", expectedVersion: -3 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A valid row version is required.");
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a NON-INTEGER expectedVersion", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name", expectedVersion: 1.5 });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("A valid row version is required.");
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a NON-NUMBER expectedVersion", () => {
    const result = updateAdvisorSchema.safeParse({ advisorName: "New Name", expectedVersion: "4" });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a missing expectedVersion on a role change even with a reason", () => {
    const result = updateAdvisorSchema.safeParse({ role: "Admin", reason: "Promotion" });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a missing expectedVersion on an active-state change even with a reason", () => {
    const result = updateAdvisorSchema.safeParse({ isActive: true, reason: "Reactivate" });
    expect(result.success).toBe(false);
    expect(paths(result)).toContainEqual(["expectedVersion"]);
  });

  it("rejects a combined role + isActive payload (unchanged behavior)", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Admin",
      isActive: true,
      reason: "Combined",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Role, active-state, and advisor name cannot be updated in the same request."
    );
  });

  it("rejects a combined role + advisorName payload", () => {
    const result = updateAdvisorSchema.safeParse({
      role: "Admin",
      advisorName: "New Name",
      reason: "Combined",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Role, active-state, and advisor name cannot be updated in the same request."
    );
  });

  it("rejects a combined isActive + advisorName payload", () => {
    const result = updateAdvisorSchema.safeParse({
      isActive: false,
      advisorName: "New Name",
      reason: "Combined",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain(
      "Role, active-state, and advisor name cannot be updated in the same request."
    );
  });

  it("rejects email on an advisor-name edit (email is read-only, R4)", () => {
    const result = updateAdvisorSchema.safeParse({
      advisorName: "New Name",
      email: "updated@example.com",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('Unrecognized key: "email"');
  });

  it("rejects auth_user_id (no rebinding via the API)", () => {
    const result = updateAdvisorSchema.safeParse({
      advisorName: "New Name",
      auth_user_id: "00000000-0000-4000-8000-000000000000",
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('Unrecognized key: "auth_user_id"');
  });

  it("rejects a client-supplied actor id (actor identity is never a payload field)", () => {
    const result = updateAdvisorSchema.safeParse({
      advisorName: "New Name",
      actorAdvisorId: 999,
      expectedVersion: 2,
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain('Unrecognized key: "actorAdvisorId"');
  });
});