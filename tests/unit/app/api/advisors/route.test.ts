/**
 * tests/unit/app/api/advisors/route.test.ts
 *
 * Contract for the protected advisor-management API root route:
 *
 *   GET  /api/advisors → list advisors (effective-Admin only)
 *   POST /api/advisors → provision an advisor (create/invite Auth identity,
 *                        bind, matching claim + display role; effective-Admin
 *                        only; trusted server-only provisioning adapter)
 *
 * The route auth gate is the shared server effective-Admin predicate
 * (boolean `app_metadata.ocf_admin` claim + active, pre-bound advisor). No
 * service key is ever constructed/exposed to the client; `createProvisioningClient`
 * is mocked so real provisioning never executes here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

const { getSessionUser, getEffectiveAdmin } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getEffectiveAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser,
  getEffectiveAdmin,
  ADVISOR_ROLES: ["Admin", "Advisor"] as const,
}));

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

const { createProvisioningClient } = vi.hoisted(() => ({
  createProvisioningClient: vi.fn(),
}));

vi.mock("@/lib/provisioning", () => ({
  createProvisioningClient,
}));

// ── Route under test ────────────────────────────────────────────────────────

import { GET, POST } from "@/app/api/advisors/route";

const ADMIN_ADVISOR = {
  advisor_id: 1,
  advisor_name: "Admin One",
  email: "admin@example.com",
  role: "Admin",
  is_active: true,
  auth_user_id: "user-admin",
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

function createMockSupabase() {
  const query = {
    select: vi.fn(),
    order: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    range: vi.fn(),
    maybeSingle: vi.fn(),
    single: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.range.mockResolvedValue({ data: [], error: null, count: 0 });
  query.maybeSingle.mockResolvedValue({ data: null, error: null });

  const client = {
    from: vi.fn().mockReturnValue(query),
    rpc: vi.fn(),
  };

  return { client, query };
}

const provisioner = {
  provisionAdvisor: vi.fn(),
  setAdvisorRole: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  createProvisioningClient.mockReturnValue(provisioner);
  createServerClient.mockReturnValue(createMockSupabase().client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GET /api/advisors ───────────────────────────────────────────────────────

/** Advisor row as returned by the list projection (no Auth binding data). */
const LIST_ADVISOR = {
  advisor_id: 1,
  advisor_name: "Admin One",
  email: "admin@example.com",
  role: "Admin",
  is_active: true,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};

function getRequest(path = "/api/advisors"): Request {
  return new Request(`http://localhost${path}`);
}

describe("GET /api/advisors (admin-only list)", () => {
  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await GET(getRequest());
    expect(response.status).toBe(401);
  });

  it("returns 403 for a session that is not an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    getEffectiveAdmin.mockResolvedValue(null);

    const response = await GET(getRequest());
    expect(response.status).toBe(403);
  });

  it("returns a paginated list with normalized metadata for an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [LIST_ADVISOR], error: null, count: 1 });
    createServerClient.mockReturnValue(client);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      advisors: [LIST_ADVISOR],
      page: 1,
      pageSize: 25,
      totalCount: 1,
      totalPages: 1,
    });
    expect(client.from).toHaveBeenCalledWith("advisor");
    expect(query.select).toHaveBeenCalledWith(
      expect.not.stringContaining("auth_user_id"),
      { count: "exact" }
    );
    expect(query.range).toHaveBeenCalledWith(0, 24);
    expect(query.order).toHaveBeenNthCalledWith(1, "advisor_name", {
      ascending: true,
      nullsFirst: false,
    });
    expect(query.order).toHaveBeenNthCalledWith(2, "advisor_id", { ascending: true });
  });

  it("parses safe pagination/search/active/role/sort/direction params", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    const response = await GET(
      getRequest(
        "/api/advisors?page=2&pageSize=50&search=Jane&role=Admin&active=true&sort=email&direction=desc"
      )
    );
    expect(response.status).toBe(200);
    expect(query.range).toHaveBeenCalledWith(50, 99);
    expect(query.or).toHaveBeenCalledWith(
      "advisor_name.ilike.*Jane*,email.ilike.*Jane*"
    );
    expect(query.eq).toHaveBeenCalledWith("role", "Admin");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.order).toHaveBeenNthCalledWith(1, "email", {
      ascending: false,
      nullsFirst: false,
    });
  });

  it("normalizes malformed/unsafe query state to safe defaults", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    const response = await GET(
      getRequest(
        "/api/advisors?page=-3&pageSize=999&role=Superuser&active=maybe&sort=email;drop&direction=sideways"
      )
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(query.range).toHaveBeenCalledWith(0, 24);
    expect(query.eq).not.toHaveBeenCalled();
    expect(query.or).not.toHaveBeenCalled();
    expect(body).toMatchObject({ page: 1, pageSize: 25, totalCount: 0, totalPages: 0 });
  });

  it("neutralizes PostgREST filter delimiters in search", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    await GET(getRequest("/api/advisors?search=Smith%2C%20Jr.(x)"));

    const orArgument = query.or.mock.calls[0][0] as string;
    // Exactly two clauses: the user's comma/parens were neutralized rather than
    // creating extra OR terms.
    expect(orArgument.split(",")).toHaveLength(2);
    expect(orArgument).toBe("advisor_name.ilike.*Smith Jr. x*,email.ilike.*Smith Jr. x*");
  });

  it("canonicalizes an out-of-range page to the last valid page with one replacement query", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range
      .mockResolvedValueOnce({ data: [], error: null, count: 30 })
      .mockResolvedValueOnce({ data: [LIST_ADVISOR], error: null, count: 30 });
    createServerClient.mockReturnValue(client);

    const response = await GET(getRequest("/api/advisors?page=5&pageSize=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(query.range).toHaveBeenNthCalledWith(1, 100, 124);
    expect(query.range).toHaveBeenNthCalledWith(2, 25, 49);
    expect(body).toEqual({
      advisors: [LIST_ADVISOR],
      page: 2,
      pageSize: 25,
      totalCount: 30,
      totalPages: 2,
    });
  });

  it("canonicalizes a zero-result page>1 to page 1 without a replacement query", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    const response = await GET(getRequest("/api/advisors?page=5&pageSize=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    // The first bounded range already returned the empty page, so metadata
    // canonicalizes to page 1 with no spare replacement query.
    expect(query.range).toHaveBeenCalledTimes(1);
    expect(query.range).toHaveBeenCalledWith(100, 124);
    expect(body).toEqual({
      advisors: [],
      page: 1,
      pageSize: 25,
      totalCount: 0,
      totalPages: 0,
    });
  });

  it("returns an honest empty page rather than an error when no advisors match", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({ data: [], error: null, count: 0 });
    createServerClient.mockReturnValue(client);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      advisors: [],
      page: 1,
      pageSize: 25,
      totalCount: 0,
      totalPages: 0,
    });
  });

  it("masks a failing advisor read as a generic 500", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.range.mockResolvedValue({
      data: null,
      error: { name: "PostgrestError", message: "boom" },
      count: null,
    });
    createServerClient.mockReturnValue(client);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
  });
});

// ── POST /api/advisors ──────────────────────────────────────────────────────

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/advisors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/advisors (admin-only provisioning)", () => {
  it("returns 400 for an invalid body", async () => {
    const response = await POST(postRequest({ email: "not-an-email" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-object body", async () => {
    const response = await POST(postRequest("nope"));
    expect(response.status).toBe(400);
  });

  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await POST(postRequest({ email: "jane@example.com" }));
    expect(response.status).toBe(401);
    expect(createProvisioningClient).not.toHaveBeenCalled();
  });

  it("returns 403 for a session that is not an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    getEffectiveAdmin.mockResolvedValue(null);

    const response = await POST(postRequest({ email: "jane@example.com" }));
    expect(response.status).toBe(403);
    expect(createProvisioningClient).not.toHaveBeenCalled();
  });

  it("provisions an Advisor through the trusted adapter (201)", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    provisioner.provisionAdvisor.mockResolvedValue({
      ok: true,
      advisorId: 42,
      authUserId: "invited-user-1",
      created: true,
      role: "Admin",
    });

    const response = await POST(
      postRequest({ email: "jane@example.com", displayName: "Jane", role: "Admin", method: "create" })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      advisorId: 42,
      role: "Admin",
      created: true,
      provisioned: true,
    });
    expect(provisioner.provisionAdvisor).toHaveBeenCalledWith({
      email: "jane@example.com",
      name: "Jane",
      role: "Admin",
      method: "create",
    });
  });

  it.each([
    { code: "already_bound", status: 409 },
    { code: "advisor_not_found", status: 404 },
    { code: "invite_failed", status: 502 },
    { code: "create_failed", status: 502 },
    { code: "bind_failed", status: 502 },
    { code: "role_set_failed", status: 502 },
  ] as const)("maps a $code provisioning failure to HTTP $status", async ({ code, status }) => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    provisioner.provisionAdvisor.mockResolvedValue({
      ok: false,
      code,
      message: "Generic provisioning failure.",
    });

    const response = await POST(postRequest({ email: "jane@example.com" }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: "Generic provisioning failure." });
  });

  it("masks a thrown provisioning client as a generic 500", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    provisioner.provisionAdvisor.mockRejectedValue(new Error("provisioning exploded"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest({ email: "jane@example.com" }));
    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
  });
});