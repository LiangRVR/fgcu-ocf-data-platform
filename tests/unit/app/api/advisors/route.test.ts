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
    maybeSingle: vi.fn(),
    single: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.eq.mockReturnValue(query);
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

describe("GET /api/advisors (admin-only list)", () => {
  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("returns 403 for a session that is not an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    getEffectiveAdmin.mockResolvedValue(null);

    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("lists advisors for an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.order.mockResolvedValue({ data: [ADMIN_ADVISOR], error: null });
    createServerClient.mockReturnValue(client);

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ advisors: [ADMIN_ADVISOR] });
    expect(client.from).toHaveBeenCalledWith("advisor");
  });

  it("returns an empty list when no advisors match", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.order.mockResolvedValue({ data: [], error: null });
    createServerClient.mockReturnValue(client);

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ advisors: [] });
  });

  it("masks a failing advisor read as a generic 500", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const { client, query } = createMockSupabase();
    query.order.mockResolvedValue({ data: null, error: { name: "PostgrestError", message: "boom" } });
    createServerClient.mockReturnValue(client);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();
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