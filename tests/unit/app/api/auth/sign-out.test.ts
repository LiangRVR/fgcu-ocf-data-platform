import { afterEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

// ── Route under test ────────────────────────────────────────────────────────

import { POST } from "@/app/api/auth/sign-out/route";

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockSupabase(signOutResult: { error: unknown }) {
  const client = {
    auth: {
      signOut: vi.fn().mockResolvedValue(signOutResult),
    },
  };
  createServerClient.mockReturnValue(client as never);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── POST /api/auth/sign-out ─────────────────────────────────────────────────

describe("POST /api/auth/sign-out", () => {
  it("returns success when signOut resolves without an error", async () => {
    const client = mockSupabase({ error: null });

    const res = await POST();

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("returns 500 with a generic message when signOut fails", async () => {
    const client = mockSupabase({
      error: {
        message: "no session found for token=abc123 user=alice@example.com",
        details: "secret=pqrstuvw",
        hint: "credential=super-secret-key",
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST();

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = await res.json();

    // The raw provider error message is never returned to the client.
    expect(body).toEqual({ success: false, message: "Unable to sign out." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("no session found");
    expect(serialized).not.toContain("token=abc123");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("super-secret-key");

    // No raw provider error message is logged either: the server-side trace is
    // a route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:auth:sign-out]");
    expect(logged).not.toContain("no session found");
    expect(logged).not.toContain("token=abc123");
    expect(logged).not.toContain("alice@example.com");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("super-secret-key");
  });

  it("returns 500 with a generic message when signOut rejects (thrown provider error)", async () => {
    const client = {
      auth: {
        signOut: vi
          .fn()
          .mockRejectedValue(
            new Error("network down: token=abc123 user=alice@example.com")
          ),
      },
    };
    createServerClient.mockReturnValue(client as never);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST();

    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = await res.json();

    // The thrown provider error is masked and never reaches the response.
    expect(body).toEqual({ success: false, message: "Unable to sign out." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("network down");
    expect(serialized).not.toContain("token=abc123");
    expect(serialized).not.toContain("alice@example.com");

    // No raw provider error is logged either: the server-side trace is a
    // route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:auth:sign-out]");
    expect(logged).not.toContain("network down");
    expect(logged).not.toContain("token=abc123");
    expect(logged).not.toContain("alice@example.com");
  });
});