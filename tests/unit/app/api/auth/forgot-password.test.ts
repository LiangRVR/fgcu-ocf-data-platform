import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

// ── Route under test ────────────────────────────────────────────────────────

import { POST } from "@/app/api/auth/forgot-password/route";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A request whose origin/Host is attacker-controlled. The route must derive
 * the reset redirect from server configuration only and ignore this origin.
 */
function makeRequest(email: unknown, origin = "https://evil.example.com") {
  return {
    json: async () => ({ email }),
    nextUrl: { origin },
  } as unknown as NextRequest;
}

function mockSupabase(resetResult: { error: unknown }) {
  const client = {
    auth: {
      resetPasswordForEmail: vi.fn().mockResolvedValue(resetResult),
    },
  };
  createServerClient.mockReturnValue(client as never);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Server-controlled reset origin (e.g. set in the deploy environment).
  vi.stubEnv("APP_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── POST /api/auth/forgot-password ──────────────────────────────────────────

describe("POST /api/auth/forgot-password", () => {
  it("returns 400 for an invalid email without calling Supabase", async () => {
    const res = await POST(makeRequest("not-an-email"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();

    // Validation runs before the Supabase client is created.
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("normalizes the email and redirects to the server-controlled origin on success", async () => {
    const client = mockSupabase({ error: null });

    const res = await POST(
      makeRequest("  JANE@EXAMPLE.COM  ", "https://evil.example.com")
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "jane@example.com",
      { redirectTo: "https://app.example.com/reset-password" }
    );
  });

  it("ignores a malicious client-supplied origin and uses the server-controlled origin", async () => {
    const client = mockSupabase({ error: null });

    // The attacker-controlled Host/origin must never influence the reset link.
    const res = await POST(
      makeRequest("jane@example.com", "https://evil.example.com")
    );

    expect(res.status).toBe(200);
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "jane@example.com",
      { redirectTo: "https://app.example.com/reset-password" }
    );
  });

  it("returns 500 with a generic message when the reset request fails", async () => {
    const client = mockSupabase({
      error: {
        message: "rate limited for jane@example.com smtp://apikey:secret@mail.internal",
        details: "token=abc123",
        hint: "secret=pqrstuvw",
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(makeRequest("jane@example.com", "https://evil.example.com"));

    expect(res.status).toBe(500);
    const body = await res.json();

    // The raw provider error message is never returned to the client.
    expect(body).toEqual({ error: "Unable to send reset email." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("rate limited");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("secret");

    // No raw provider error message is logged either: the server-side trace is
    // a route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:auth:forgot-password]");
    expect(logged).not.toContain("rate limited");
    expect(logged).not.toContain("jane@example.com");
    expect(logged).not.toContain("apikey");
    expect(logged).not.toContain("secret");

    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "jane@example.com",
      { redirectTo: "https://app.example.com/reset-password" }
    );
  });

  it.each(["", "not-a-url", "ftp://app.example.com"])(
    "returns a generic 500 when the reset origin is missing or invalid (APP_URL=%s)",
    async (appUrl) => {
      vi.stubEnv("APP_URL", appUrl);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = await POST(
        makeRequest("jane@example.com", "https://evil.example.com")
      );

      expect(res.status).toBe(500);
      const body = await res.json();

      // The config blocker is masked: no config variable names or values leak.
      expect(body).toEqual({ error: "Unable to send reset email." });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("APP_URL");
      expect(serialized).not.toContain("app.example.com");

      // No provider call is made when the origin is not configured.
      expect(createServerClient).not.toHaveBeenCalled();

      // The server-side trace is route-tagged and generic only.
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.join("\n");
      expect(logged).toContain("[api:auth:forgot-password]");
      expect(logged).not.toContain("APP_URL");
      expect(logged).not.toContain("app.example.com");
    }
  );

  it("returns 500 with a generic message when the reset provider call rejects", async () => {
    const client = {
      auth: {
        resetPasswordForEmail: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "network down: smtp://apikey:secret@mail.internal token=abc123"
            )
          ),
      },
    };
    createServerClient.mockReturnValue(client as never);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      makeRequest("jane@example.com", "https://evil.example.com")
    );

    expect(res.status).toBe(500);
    const body = await res.json();

    // The thrown provider error is masked and never reaches the response.
    expect(body).toEqual({ error: "Unable to send reset email." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("network down");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token=abc123");

    // No raw provider error is logged either: the server-side trace is a
    // route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:auth:forgot-password]");
    expect(logged).not.toContain("network down");
    expect(logged).not.toContain("apikey");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("token=abc123");

    // The route still resolves to the server-controlled origin.
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      "jane@example.com",
      { redirectTo: "https://app.example.com/reset-password" }
    );
  });
});