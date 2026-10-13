import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Please enter a valid email address");

const advisorNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(120, "Name must be 120 characters or fewer");

/**
 * Ordinary self-service profile updates are NAME-ONLY (R4/design point 7):
 * `advisor.email` is read-only and can never be written through this route.
 *
 * `expectedVersion` is the caller's loaded `advisor.row_version`; the
 * `update_my_advisor_profile` writer rejects a stale value with `PT409` before
 * any change. It is required so a stale form can never silently overwrite a
 * newer profile.
 *
 * `email` is accepted here ONLY so the route can detect — and reject — a
 * hand-off attempt: the schema validates format (when non-empty), then the
 * route refuses (400) any value that differs from the advisor's current login
 * email, and the UPDATE writes `advisor_name` only. Absent or empty values
 * (a null-email advisor echoing the read-only field) are allowed so existing
 * clients can keep sending the echoed value without a hard failure. There is
 * no path here that changes Auth identity or the advisor email projection.
 */
export const profileUpdateSchema = z.object({
  advisorName: advisorNameSchema,
  expectedVersion: z
    .number()
    .int("A valid row version is required.")
    .positive("A valid row version is required."),
  email: z.union([z.literal(""), emailSchema]).optional(),
});

export const passwordUpdateSchema = z
  .object({
    newPassword: z
      .string()
      .min(10, "Password must be at least 10 characters")
      .max(72, "Password must be 72 characters or fewer"),
    confirmPassword: z
      .string()
      .min(1, "Please confirm your password"),
  })
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords do not match",
      });
    }
  });

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export type ProfileUpdateValues = z.infer<typeof profileUpdateSchema>;
export type PasswordUpdateValues = z.infer<typeof passwordUpdateSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
