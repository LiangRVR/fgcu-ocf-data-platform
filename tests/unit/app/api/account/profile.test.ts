import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

// ── Module mocks ────────────────────────────────────────────────────────────

const { getSessionUser, getCurrentAdvisor } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getCurrentAdvisor: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser,
  getCurrentAdvisor,
}));

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

// ── Route under test ────────────────────────────────────────────────────────

import { PATCH } from "@/app/api/account/profile/route";

type Advisor = Database["public"]["Tables"]["advisor"]["Row"];

// ── Helpers ─────────────────────────────────────────────────────────────────

const validBody = {
  advisorName: "Jane Doe",
  email: "jane@example.com",
};

function makeAdvisor(overrides: Partial<Advisor> = {}): Advisor {
  return {
    advisor_id: 1,
    advisor_name: "Jane Advisor",
    auth_user_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    email: "jane@example.com",
    is_active: true,
    last_login_at: null,
    role: "admin",
    ...overrides,
  };
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/account/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createMockSupabase() {
  const query = {
    update: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
  };
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.select.mockReturnValue(query);
  query.single.mockResolvedValue({ data: null, error: null });

  const client = {
    from: vi.fn().mockReturnValue(query),
  };

  return { client, query };
}

let query: ReturnType<typeof createMockSupabase>["query"];

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockSupabase();
  query = mock.query;
  createServerClient.mockReturnValue(mock.client as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── PATCH /api/account/profile ──────────────────────────────────────────────

describe("PATCH /api/account/profile", () => {
  it("rejects an invalid payload with 400 before any auth/Supabase work", async () => {
    const res = await PATCH(
      patchRequest({ advisorName: "A", email: "not-an-email" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();

    // Validation runs before authentication.
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(getCurrentAdvisor).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      })
    );

    expect(res.status).toBe(400);
    expect(getSessionUser).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session user", async () => {
    getSessionUser.mockResolvedValue(null);

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Authentication required.",
    });
    expect(getCurrentAdvisor).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("returns 403 when no advisor is found for the session user", async () => {
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(null);

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Advisor access required.",
    });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("returns 403 when the advisor is inactive", async () => {
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(
      makeAdvisor({ advisor_id: 42, auth_user_id: "user-123", is_active: false })
    );

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "Advisor access required.",
    });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("applies the normalized field-only update scoped to the advisor row", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);

    const updated = makeAdvisor({
      advisor_id: 42,
      advisor_name: "Jane Doe",
      email: "jane@example.com",
    });
    query.single.mockResolvedValue({ data: updated, error: null });

    const res = await PATCH(
      patchRequest({
        advisorName: "  Jane Doe  ",
        email: "  JANE@EXAMPLE.COM  ",
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ advisor: updated });

    // Only the two profile fields are written, using the schema-normalized
    // (trimmed / lowercased) values.
    expect(query.update).toHaveBeenCalledWith({
      advisor_name: "Jane Doe",
      email: "jane@example.com",
    });
    expect(Object.keys(query.update.mock.calls[0][0])).toEqual([
      "advisor_name",
      "email",
    ]);

    // The update is scoped to the advisor resolved from the session.
    expect(query.eq).toHaveBeenCalledWith("advisor_id", 42);
    expect(query.select).toHaveBeenCalledWith(
      "advisor_id, advisor_name, email, role, is_active, last_login_at"
    );
  });

  it("returns 500 with a generic message when the update fails", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    query.single.mockResolvedValue({
      data: null,
      error: {
        message: "connection reset for postgres://user:hunter2@db.internal:5432",
        details: "token=abc123",
        hint: "secret=pqrstuvw",
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();

    // The raw DB error message is never returned to the client.
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("connection reset");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("token=abc123");
    expect(serialized).not.toContain("secret=pqrstuvw");

    // No raw provider error message is logged either: the server-side trace is
    // a route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:account:profile]");
    expect(logged).not.toContain("connection reset");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("token=abc123");
    expect(logged).not.toContain("secret=pqrstuvw");
  });

  it("returns 500 with a generic message when the update rejects (thrown provider error)", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);

    // The provider rejects the whole query chain (e.g. a network failure).
    query.single.mockRejectedValue(
      new Error(
        "network down for postgres://user:hunter2@db.internal:5432 token=abc123"
      )
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();

    // The thrown provider error is masked and never reaches the response.
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("network down");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("token=abc123");

    // No raw provider error is logged either: the server-side trace is a
    // route-tagged generic message only, free of PII/credentials.
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:account:profile]");
    expect(logged).not.toContain("network down");
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("token=abc123");
  });

  it("returns 500 with a generic message when the session lookup throws", async () => {
    // A thrown (not null) session lookup — provider/request-context rejection —
    // must be masked by the same generic 500 as a thrown update, never an
    // uncaught escape to a framework default.
    getSessionUser.mockRejectedValue(
      new Error("session provider down for https://auth.internal token=abc123")
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("session provider down");
    expect(serialized).not.toContain("auth.internal");
    expect(serialized).not.toContain("token=abc123");

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:account:profile]");
    expect(logged).not.toContain("session provider down");
    expect(logged).not.toContain("token=abc123");
  });

  it("returns 500 with a generic message when the advisor lookup throws", async () => {
    getSessionUser.mockResolvedValue({ id: "user-123" });
    // A thrown (not null) advisor lookup — provider/network rejection — is
    // masked as a generic 500; only a resolved null/inactive advisor is 403.
    getCurrentAdvisor.mockRejectedValue(
      new Error("advisor lookup failed for postgres://db.internal token=abc123")
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("advisor lookup failed");
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("token=abc123");

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:account:profile]");
    expect(logged).not.toContain("advisor lookup failed");
    expect(logged).not.toContain("token=abc123");
  });

  it("returns 500 with a generic message when the server client construction throws", async () => {
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(
      makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" })
    );
    // Client construction happens inside the failure boundary too: a THROWN
    // construction/request-context error is a generic 500.
    createServerClient.mockImplementation(() => {
      throw new Error("cookies() can only be used in a request scope token=abc123");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("cookies()");
    expect(serialized).not.toContain("token=abc123");

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).toContain("[api:account:profile]");
    expect(logged).not.toContain("cookies()");
    expect(logged).not.toContain("token=abc123");
  });
});