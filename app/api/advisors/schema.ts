/**
 * app/api/advisors/schema.ts
 *
 * Shared request validation for the protected advisor-management API routes
 * (list/read/provision/update). The role vocabulary is exactly `Admin` and
 * `Advisor` (migration 20261001000001); `advisor.role` is a protected display
 * projection and is never accepted from an unauthenticated/unauthorized path.
 */
import { z } from "zod";
import { ADVISOR_ROLES } from "@/lib/auth/session";

export const advisorRoleSchema = z.enum(ADVISOR_ROLES);

export type AdvisorRoleValue = z.infer<typeof advisorRoleSchema>;

/**
 * Provision: create/invite the Auth identity with a matching role claim, then
 * create the advisor record bound to it (display name, matching protected
 * display role, active by default). Unknown keys (including `auth_user_id`)
 * are rejected fail-closed.
 */
export const provisionAdvisorSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Please enter a valid email address"),
  displayName: z
    .string()
    .trim()
    .min(2, "Display name must be at least 2 characters")
    .max(120)
    .optional(),
  role: advisorRoleSchema.optional(),
  method: z.enum(["invite", "create"]).optional(),
});

export type ProvisionAdvisorValues = z.infer<typeof provisionAdvisorSchema>;

/**
 * Update: change the target's role OR active state OR advisor name — exactly
 * one mutation per request — fail-closed with 400. A combined payload
 * (`role` + `isActive`, `role` + `advisorName`, `isActive` + `advisorName`) is
 * rejected BEFORE any state change, so a partial application can never occur.
 *
 * The `reason` is a REQUIRED non-blank human reason only for the privileged
 * role and active-state mutations (role changes and advisor
 * activate/deactivate both require a human-attributable reason per the
 * approved plan, design points 4–5). An advisor-name edit — the trusted
 * effective-Admin profile change for another advisor (review remediation) —
 * is an ordinary profile edit: it records one `updated` event attributed to
 * the acting Admin and does NOT require a reason (R8).
 *
 * `email` is deliberately NOT accepted: advisor login email is read-only for
 * ordinary profile editing (R4) and can diverge from Auth only through a
 * future explicit trusted account-management workflow. The actor identity is
 * never part of the payload: the route injects the server-resolved
 * effective-Admin id into the trusted operations, and the profile RPC derives
 * the actor from the authenticated session. Unknown keys — most importantly
 * `auth_user_id` (no rebinding via the API) and client actor fields — are
 * rejected fail-closed with 400.
 */
export const updateAdvisorSchema = z
  .strictObject({
    role: advisorRoleSchema.optional(),
    isActive: z.boolean().optional(),
    advisorName: z
      .string()
      .trim()
      .min(2, "Name must be at least 2 characters")
      .max(120, "Name must be 120 characters or fewer")
      .optional(),
    reason: z
      .string()
      .trim()
      .min(1, "A reason is required.")
      .max(500, "Reason must be 500 characters or fewer")
      .optional(),
    /**
     * The caller's loaded target `advisor.row_version`. The versioned writers
     * (`set_advisor_role`, `lifecycle_transition`,
     * `update_advisor_profile_name`) reject a stale value with `PT409` before
     * any change, so a stale admin form can never overwrite newer work.
     */
    expectedVersion: z
      .number()
      .int("A valid row version is required.")
      .positive("A valid row version is required."),
  })
  .refine(
    (value) =>
      value.role !== undefined ||
      value.isActive !== undefined ||
      value.advisorName !== undefined,
    { message: "Provide role, isActive, or advisorName to update an advisor." }
  )
  .refine(
    (value) =>
      [value.role, value.isActive, value.advisorName].filter(
        (field) => field !== undefined
      ).length === 1,
    { message: "Role, active-state, and advisor name cannot be updated in the same request." }
  )
  .superRefine((value, ctx) => {
    if (
      value.reason === undefined &&
      (value.role !== undefined || value.isActive !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required.",
      });
    }
  });

export type UpdateAdvisorValues = z.infer<typeof updateAdvisorSchema>;