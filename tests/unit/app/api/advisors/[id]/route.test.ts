/**
 * tests/unit/app/api/advisors/[id]/route.test.ts
 *
 * Contract for the protected advisor-management detail route:
 *
 *   GET   /api/advisors/[id] → read one advisor (effective-Admin only)
 *   PATCH /api/advisors/[id] → update the target's role (trusted provisioning
 *                              adapter) and/or active state (established
 *                              `lifecycle_transition` RPC through the admin's
 *                              own server session)
 *
 * `auth_user_id` is never accepted by PATCH, so no API path can rebind an
 * existing binding. The route gate is the shared server effective-Admin
 * predicate; `createProvisioningClient` and the RPC are mocked.
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

import { GET, PATCH } from "@/app/api/advisors/[id]/route";

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

let client: ReturnType<typeof createMockSupabase>["client"];
let query: ReturnType<typeof createMockSupabase>["query"];

beforeEach(() => {
  vi.clearAllMocks();
  createProvisioningClient.mockReturnValue(provisioner);
  const mock = createMockSupabase();
  client = mock.client;
  query = mock.query;
  createServerClient.mockReturnValue(client);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/advisors/7", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const CONTEXT = { params: Promise.resolve({ id: "7" }) } as never;

// ── GET /api/advisors/[id] ──────────────────────────────────────────────────

describe("GET /api/advisors/[id] (admin-only read)", () => {
  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/advisors/7"), CONTEXT);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a session that is not an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    getEffectiveAdmin.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/advisors/7"), CONTEXT);
    expect(response.status).toBe(403);
  });

  it("returns 400 for a non-numeric advisor id", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);

    const response = await GET(new Request("http://localhost/api/advisors/abc"), {
      params: Promise.resolve({ id: "abc" }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("returns the advisor for an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: ADMIN_ADVISOR, error: null });

    const response = await GET(new Request("http://localhost/api/advisors/1"), {
      params: Promise.resolve({ id: "1" }),
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ advisor: ADMIN_ADVISOR });
    expect(query.eq).toHaveBeenCalledWith("advisor_id", 1);
  });

  it("returns 404 when the advisor does not exist", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    const response = await GET(new Request("http://localhost/api/advisors/999"), {
      params: Promise.resolve({ id: "999" }),
    } as never);
    expect(response.status).toBe(404);
  });
});

// ── PATCH /api/advisors/[id] ────────────────────────────────────────────────

describe("PATCH /api/advisors/[id] (admin-only role / active-state update)", () => {
  it("returns 400 for an empty body (nothing to update)", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);

    const response = await PATCH(patchRequest({}), CONTEXT);
    expect(response.status).toBe(400);
    expect(provisioner.setAdvisorRole).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload accepts auth_user_id (no rebinding via the API)", async () => {
    const response = await PATCH(
      patchRequest({ role: "Admin", auth_user_id: "00000000-0000-4000-8000-000000000000" }),
      CONTEXT
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when there is no session", async () => {
    getSessionUser.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(401);
  });

  it("returns 403 for a session that is not an effective Admin", async () => {
    getSessionUser.mockResolvedValue({ id: "user-1" });
    getEffectiveAdmin.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(403);
    expect(provisioner.setAdvisorRole).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric advisor id", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);

    const response = await PATCH(patchRequest({ role: "Admin" }), {
      params: Promise.resolve({ id: "abc" }),
    } as never);
    expect(response.status).toBe(400);
  });

  it("returns 404 when the target advisor does not exist", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(404);
    expect(provisioner.setAdvisorRole).not.toHaveBeenCalled();
  });

  it("updates the role through the trusted adapter and returns the refreshed advisor", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const target = { ...ADMIN_ADVISOR, advisor_id: 7, role: "Admin" };
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 7 }, error: null }) // existence check
      .mockResolvedValueOnce({ data: target, error: null }); // re-read
    provisioner.setAdvisorRole.mockResolvedValue({
      ok: true,
      advisorId: 7,
      role: "Admin",
      authUserId: "user-7",
    });

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ advisor: target });
    expect(provisioner.setAdvisorRole).toHaveBeenCalledWith({ advisorId: 7, role: "Admin" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { code: "advisor_not_found", status: 404 },
    { code: "not_bound", status: 409 },
    { code: "role_update_failed", status: 502 },
  ] as const)("maps a $code role-change failure to HTTP $status", async ({ code, status }) => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: { advisor_id: 7 }, error: null });
    provisioner.setAdvisorRole.mockResolvedValue({
      ok: false,
      code,
      message: "Generic role failure.",
    });

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: "Generic role failure." });
  });

  it("deactivates through the established lifecycle RPC (reactivate path for isActive true)", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    const target = { ...ADMIN_ADVISOR, advisor_id: 7, is_active: true };
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 7 }, error: null })
      .mockResolvedValueOnce({ data: target, error: null });
    client.rpc.mockResolvedValue({ data: null, error: null });

    const response = await PATCH(patchRequest({ isActive: true }), CONTEXT);
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("lifecycle_transition", {
      p_entity: "advisor",
      p_action: "reactivate",
      p_entity_id: 7,
    });
    expect(provisioner.setAdvisorRole).not.toHaveBeenCalled();
  });

  it("deactivates through the established lifecycle RPC (deactivate path for isActive false)", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 7 }, error: null })
      .mockResolvedValueOnce({ data: { ...ADMIN_ADVISOR, advisor_id: 7, is_active: false }, error: null });
    client.rpc.mockResolvedValue({ data: null, error: null });

    const response = await PATCH(patchRequest({ isActive: false }), CONTEXT);
    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith("lifecycle_transition", {
      p_entity: "advisor",
      p_action: "deactivate",
      p_entity_id: 7,
    });
  });

  it("maps a 42501 lifecycle RPC rejection (e.g. self-deactivation) to 403", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: { advisor_id: 7 }, error: null });
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "cannot deactivate own account" },
    });

    const response = await PATCH(patchRequest({ isActive: false }), CONTEXT);
    expect(response.status).toBe(403);
  });

  it("maps other lifecycle RPC failures to 409", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: { advisor_id: 7 }, error: null });
    client.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "advisor does not exist" },
    });

    const response = await PATCH(patchRequest({ isActive: false }), CONTEXT);
    expect(response.status).toBe(409);
  });

  it("rejects a combined role + isActive payload with 400 BEFORE any state change (review blocker 3)", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);

    const response = await PATCH(patchRequest({ role: "Admin", isActive: true }), CONTEXT);

    expect(response.status).toBe(400);
    // Nothing was touched: no advisor read, no role change, no lifecycle RPC.
    expect(query.maybeSingle).not.toHaveBeenCalled();
    expect(provisioner.setAdvisorRole).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
describe("PATCH /api/advisors/[id] — failure paths of the final re-read", () => {
  it("returns 500 when the final re-read errors after a successful role update", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 7 }, error: null }) // existence
      .mockResolvedValueOnce({ data: null, error: { name: "PostgrestError", message: "re-read boom" } }); // re-read
    provisioner.setAdvisorRole.mockResolvedValue({
      ok: true,
      advisorId: 7,
      role: "Admin",
      authUserId: "user-7",
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("returns 404 when the final re-read finds no row after a successful update", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 7 }, error: null }) // existence
      .mockResolvedValueOnce({ data: null, error: null }); // re-read
    provisioner.setAdvisorRole.mockResolvedValue({
      ok: true,
      advisorId: 7,
      role: "Admin",
      authUserId: "user-7",
    });

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(404);
  });

  it("masks a thrown role-change as a generic 500", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: { advisor_id: 7 }, error: null });
    provisioner.setAdvisorRole.mockRejectedValue(new Error("role change exploded"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("masks a thrown existence-check as a generic 500", async () => {
    getSessionUser.mockResolvedValue({ id: "user-admin" });
    getEffectiveAdmin.mockResolvedValue(ADMIN_ADVISOR);
    query.maybeSingle.mockResolvedValue({ data: null, error: { name: "PostgrestError", message: "boom" } });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PATCH(patchRequest({ role: "Admin" }), CONTEXT);
    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
  });
});
