import { z } from "zod";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Email is required")
  .email("Please enter a valid email address");

export const profileUpdateSchema = z.object({
  advisorName: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(120, "Name must be 120 characters or fewer"),
  email: emailSchema,
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
