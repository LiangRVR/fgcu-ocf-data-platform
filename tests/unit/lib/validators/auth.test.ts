import { describe, it, expect } from "vitest";
import { loginSchema } from "@/lib/validators/auth";

function messages(result: { success: boolean; error?: unknown }): string[] {
  if (result.success) return [];
  const error = result.error as { issues: Array<{ message: string }> };
  return error.issues.map((issue) => issue.message);
}

describe("loginSchema", () => {
  it("accepts a valid email and password", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "longenough1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a password of exactly the minimum length", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "12345678",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty email", () => {
    const result = loginSchema.safeParse({ email: "", password: "longenough1" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Email is required");
  });

  it("rejects an invalid email", () => {
    const result = loginSchema.safeParse({
      email: "not-an-email",
      password: "longenough1",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Please enter a valid email address");
  });

  it("does not trim surrounding whitespace from the email (no normalization)", () => {
    const result = loginSchema.safeParse({
      email: " user@example.com ",
      password: "longenough1",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Please enter a valid email address");
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({ email: "user@example.com", password: "" });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Password is required");
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = loginSchema.safeParse({
      email: "user@example.com",
      password: "1234567",
    });
    expect(result.success).toBe(false);
    expect(messages(result)).toContain("Password must be at least 8 characters");
  });
});