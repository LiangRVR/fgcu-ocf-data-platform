import { describe, it, expect } from "vitest";
import type { z } from "zod";
import {
  profileUpdateSchema,
  passwordUpdateSchema,
  forgotPasswordSchema,
} from "@/lib/validators/account";

function messages(result: { success: boolean; error?: z.ZodError }): string[] {
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

function paths(result: { success: boolean; error?: z.ZodError }): PropertyKey[][] {
  return result.success ? [] : result.error!.issues.map((issue) => issue.path);
}

describe("profileUpdateSchema", () => {
  it("trims and lowercases valid input", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "  Ada  Lovelace ",
      email: "  ADA@EXAMPLE.com ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        advisorName: "Ada  Lovelace",
        email: "ada@example.com",
      });
    }
  });

  it("accepts the minimum-length name", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "Ab",
      email: "ada@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a name shorter than 2 characters", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "A",
      email: "ada@example.com",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Name must be at least 2 characters");
    expect(paths(result)).toContainEqual(["advisorName"]);
  });

  it("rejects a name longer than 120 characters", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "A".repeat(121),
      email: "ada@example.com",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Name must be 120 characters or fewer");
  });

  it("rejects an invalid email", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "Ada Lovelace",
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Please enter a valid email address");
    expect(paths(result)).toContainEqual(["email"]);
  });

  it("rejects an empty email", () => {
    const result = profileUpdateSchema.safeParse({
      advisorName: "Ada Lovelace",
      email: "",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Email is required");
  });
});

describe("passwordUpdateSchema", () => {
  it("accepts matching passwords of valid length", () => {
    const result = passwordUpdateSchema.safeParse({
      newPassword: "correct-horse-battery",
      confirmPassword: "correct-horse-battery",
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched passwords at the confirmPassword path", () => {
    const result = passwordUpdateSchema.safeParse({
      newPassword: "correct-horse-battery",
      confirmPassword: "wrong-horse-battery",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Passwords do not match");
    expect(paths(result)).toContainEqual(["confirmPassword"]);
  });

  it("rejects a new password shorter than 10 characters", () => {
    const result = passwordUpdateSchema.safeParse({
      newPassword: "short123",
      confirmPassword: "short123",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Password must be at least 10 characters");
  });

  it("rejects a new password longer than 72 characters", () => {
    const result = passwordUpdateSchema.safeParse({
      newPassword: "A".repeat(73),
      confirmPassword: "A".repeat(73),
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Password must be 72 characters or fewer");
  });

  it("rejects an empty confirmation", () => {
    const result = passwordUpdateSchema.safeParse({
      newPassword: "correct-horse-battery",
      confirmPassword: "",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Please confirm your password");
  });
});

describe("forgotPasswordSchema", () => {
  it("trims and lowercases a valid email", () => {
    const result = forgotPasswordSchema.safeParse({ email: "  ADA@EXAMPLE.com " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ email: "ada@example.com" });
    }
  });

  it("rejects an invalid email", () => {
    const result = forgotPasswordSchema.safeParse({ email: "nope" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Please enter a valid email address");
  });

  it("rejects an empty email", () => {
    const result = forgotPasswordSchema.safeParse({ email: "" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Email is required");
  });
});