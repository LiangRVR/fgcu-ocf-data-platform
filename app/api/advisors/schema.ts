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
 * Update: change the target's role OR active state — exactly one mutation per
 * request. A combined `role` + `isActive` payload is rejected fail-closed with
 * 400 BEFORE any state change, so a partial application can never occur. Unknown
 * keys — most importantly `auth_user_id` (no rebinding via the API) — are
 * rejected fail-closed with 400.
 */
export const updateAdvisorSchema = z
  .strictObject({
    role: advisorRoleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined, {
    message: "Provide role or isActive to update an advisor.",
  })
  .refine((value) => value.role === undefined || value.isActive === undefined, {
    message: "Role and active-state cannot be updated in the same request.",
  });

export type UpdateAdvisorValues = z.infer<typeof updateAdvisorSchema>;