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
  expectedVersion: 3,
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
    row_version: 3,
    updated_at: "2026-01-01T00:00:00.000Z",
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

/**
 * Mock the server Supabase surface the route actually uses:
 *   - `rpc("update_my_advisor_profile", …)` for the expected-version name
 *     write (PT409 on a stale version);
 *   - a `from("advisor").select(…).eq(…).single()` re-read that returns the
 *     refreshed display-safe projection with the new `row_version`.
 */
function createMockSupabase() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.single.mockResolvedValue({ data: null, error: null });

  const client = {
    from: vi.fn().mockReturnValue(query),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return { client, query };
}

let client: ReturnType<typeof createMockSupabase>["client"];
let query: ReturnType<typeof createMockSupabase>["query"];

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockSupabase();
  client = mock.client;
  query = mock.query;
  createServerClient.mockReturnValue(client as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── PATCH /api/account/profile ──────────────────────────────────────────────

describe("PATCH /api/account/profile", () => {
  it("rejects an invalid payload with 400 before any auth/Supabase work", async () => {
    const res = await PATCH(
      patchRequest({ advisorName: "A", email: "not-an-email", expectedVersion: 3 })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();

    // Validation runs before authentication.
    expect(getSessionUser).not.toHaveBeenCalled();
    expect(getCurrentAdvisor).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("rejects a payload WITHOUT the required expectedVersion with 400 (R3/R4)", async () => {
    // A stale form cannot even pass validation: the caller must always send
    // the loaded `advisor.row_version` for the versioned profile RPC.
    const res = await PATCH(
      patchRequest({ advisorName: "Jane Doe", email: "jane@example.com" })
    );

    expect(res.status).toBe(400);
    expect(getSessionUser).not.toHaveBeenCalled();
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

  it("writes ONLY the name through the expected-version RPC and returns the refreshed projection", async () => {
    const advisor = makeAdvisor({
      advisor_id: 42,
      auth_user_id: "user-123",
      email: "jane@example.com",
    });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);

    const updated = makeAdvisor({
      advisor_id: 42,
      advisor_name: "Jane Doe",
      email: "jane@example.com",
      row_version: 4,
    });
    query.single.mockResolvedValue({ data: updated, error: null });

    const res = await PATCH(
      patchRequest({
        advisorName: "  Jane Doe  ",
        email: "  JANE@EXAMPLE.COM  ",
        expectedVersion: 3,
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ advisor: updated });

    // The write goes through the expected-version RPC ONLY — no direct
    // PostgREST UPDATE can touch the protected advisor table (revoked).
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("update_my_advisor_profile", {
      // The caller's loaded row_version is propagated so the RPC can reject
      // a stale value with PT409 before any change.
      p_expected_version: 3,
      // Only the trimmed name reaches the writer; the echoed email never does.
      p_advisor_name: "Jane Doe",
    });
    expect(client.from).not.toHaveBeenCalledWith(expect.anything(), expect.anything());

    // The response re-reads the display-safe projection (never auth_user_id)
    // so the client receives the NEW row_version for its next save.
    expect(client.from).toHaveBeenCalledWith("advisor");
    expect(query.select).toHaveBeenCalledWith(
      "advisor_id, advisor_name, email, role, is_active, last_login_at, row_version"
    );
    expect(query.eq).toHaveBeenCalledWith("advisor_id", 42);
  });

  it("rejects a CHANGED email with 400 and performs NO write (email is read-only)", async () => {
    const advisor = makeAdvisor({
      advisor_id: 42,
      auth_user_id: "user-123",
      email: "jane@example.com",
    });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);

    const res = await PATCH(
      patchRequest({
        advisorName: "Jane Doe",
        email: "someone-else@example.com",
        expectedVersion: 3,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Email changes require account administration");
    // No write at all — neither the RPC nor a re-read ran.
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("accepts a payload WITHOUT email and writes only the name", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    const updated = makeAdvisor({ advisor_id: 42, advisor_name: "Jane Doe" });
    query.single.mockResolvedValue({ data: updated, error: null });

    const res = await PATCH(
      patchRequest({ advisorName: "Jane Doe", expectedVersion: 3 })
    );

    expect(res.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("update_my_advisor_profile", {
      p_expected_version: 3,
      p_advisor_name: "Jane Doe",
    });
  });

  it("allows an empty echoed email (null-email advisor) and still writes only the name", async () => {
    const advisor = makeAdvisor({
      advisor_id: 42,
      auth_user_id: "user-123",
      email: null,
    });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    const updated = makeAdvisor({
      advisor_id: 42,
      advisor_name: "Jane Doe",
      email: null,
    });
    query.single.mockResolvedValue({ data: updated, error: null });

    const res = await PATCH(
      patchRequest({ advisorName: "Jane Doe", email: "", expectedVersion: 3 })
    );

    expect(res.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("update_my_advisor_profile", {
      p_expected_version: 3,
      p_advisor_name: "Jane Doe",
    });
  });

  // ── Stale-version (PT409) handling: refresh-and-review, never retry ──────

  it("returns 409 with the refresh-and-review guidance when the RPC reports a stale version (PT409)", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    // A concurrent writer already advanced the row: the versioned RPC rejects
    // the stale expected version BEFORE any change.
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "version conflict" },
    });

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error:
        "This record was changed by another session. Refresh and review the latest information before saving.",
    });
    // No automatic retry/overwrite and no re-read of a changed row.
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("update_my_advisor_profile", {
      p_expected_version: 3,
      p_advisor_name: "Jane Doe",
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("recognises a PT409 only from a top-level PostgREST string code (PT409 vs other SQLSTATEs)", async () => {
    // The route must not treat OTHER RPC failures (22023 malformed input,
    // 42501 denied, P0002 missing row) as a stale-version conflict.
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "advisor does not exist" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Failed to update advisor profile.");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns 500 with a generic message when the update fails", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    client.rpc.mockResolvedValue({
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

    // The provider rejects the RPC (e.g. a network failure).
    client.rpc.mockRejectedValue(
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

  it("returns 500 with a generic message when the post-write re-read fails", async () => {
    const advisor = makeAdvisor({ advisor_id: 42, auth_user_id: "user-123" });
    getSessionUser.mockResolvedValue({ id: "user-123" });
    getCurrentAdvisor.mockResolvedValue(advisor);
    query.single.mockResolvedValue({
      data: null,
      error: { message: "re-read failed secret=abc123", code: "PGRST116" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await PATCH(patchRequest(validBody));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to update advisor profile." });
    expect(JSON.stringify(body)).not.toContain("abc123");
    const logged = errorSpy.mock.calls.join("\n");
    expect(logged).not.toContain("abc123");
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