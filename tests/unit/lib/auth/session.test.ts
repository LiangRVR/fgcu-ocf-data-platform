import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ── Module mocks ────────────────────────────────────────────────────────────

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient,
}));

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect,
}));

// ── Real module under test ──────────────────────────────────────────────────

import {
  getCurrentAdvisor,
  getEffectiveAdmin,
  getSessionUser,
  isAdvisorRole,
  isEffectiveAdmin,
  isOcfAdmin,
  requireAdvisor,
  ADVISOR_ROLES,
} from "@/lib/auth/session";

type Advisor = Database["public"]["Tables"]["advisor"]["Row"];

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAdvisor(overrides: Partial<Advisor> = {}): Advisor {
  return {
    advisor_id: 1,
    advisor_name: "Jane Advisor",
    auth_user_id: "user-123",
    created_at: "2026-01-01T00:00:00.000Z",
    email: "jane@example.com",
    is_active: true,
    last_login_at: null,
    role: "admin",
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-123",
    aud: "authenticated",
    role: "authenticated",
    email: "jane@example.com",
    email_confirmed_at: undefined,
    phone: "",
    confirmation_sent_at: undefined,
    confirmed_at: undefined,
    recovery_sent_at: undefined,
    email_change_sent_at: undefined,
    last_sign_in_at: undefined,
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Builds a chainable fake Supabase client. The query builder is shared across
 * `.from("advisor")` calls.
 */
function createMockSupabase() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });

  const client = {
    auth: {
      getClaims: vi.fn(),
      getUser: vi.fn(),
    },
    from: vi.fn().mockReturnValue(query),
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
  createServerClient.mockReturnValue(client as unknown as SupabaseClient<Database>);
});

// ── getSessionUser ──────────────────────────────────────────────────────────

describe("getSessionUser", () => {
  it("returns null when the claims lookup fails", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: null,
      error: new Error("unable to verify claims"),
    });

    await expect(getSessionUser()).resolves.toBeNull();
    expect(client.auth.getUser).not.toHaveBeenCalled();
  });

  it("returns null when claims are missing the sub claim", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: { claims: {}, header: {}, signature: {} },
      error: null,
    } as never);

    await expect(getSessionUser()).resolves.toBeNull();
    expect(client.auth.getUser).not.toHaveBeenCalled();
  });

  it("returns null when getUser fails", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: new Error("token expired"),
    });

    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns the session user on success", async () => {
    const user = makeUser();
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({ data: { user }, error: null });

    await expect(getSessionUser()).resolves.toBe(user);
  });
});

// ── getCurrentAdvisor ───────────────────────────────────────────────────────

describe("getCurrentAdvisor (resolves by pre-bound auth_user_id only)", () => {
  it("returns null when the session user has no id", async () => {
    await expect(getCurrentAdvisor({} as User)).resolves.toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("returns the advisor whose auth_user_id equals the session user id (pre-bound)", async () => {
    const user = makeUser({ id: "user-123" });
    const advisor = makeAdvisor({
      advisor_id: 7,
      auth_user_id: "user-123",
      email: "jane@example.com",
      is_active: true,
    });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(getCurrentAdvisor(user)).resolves.toEqual(advisor);
    expect(query.eq).toHaveBeenCalledWith("auth_user_id", "user-123");
    // Single lookup only: no email fallback, no RPC, no update.
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns null when the pre-bound lookup errors", async () => {
    const user = makeUser({ id: "user-123", email: "jane@example.com" });
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: new Error("db unavailable"),
    });

    await expect(getCurrentAdvisor(user)).resolves.toBeNull();
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns null when no advisor is bound to the session user (unbound email match is NOT an advisor session)", async () => {
    // The user's email matches an advisor row, but that row is unlinked
    // (auth_user_id IS NULL). Pre-existing-matching-account takeover (row 8):
    // the account can never claim/bind the identity, and the session must not
    // resolve it.
    const user = makeUser({ id: "user-123", email: "jane@example.com" });
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getCurrentAdvisor(user)).resolves.toBeNull();
    // No email lookup, no RPC, no self-link UPDATE ever runs.
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns null when the only matching advisor row is bound to a DIFFERENT auth user", async () => {
    const user = makeUser({ id: "user-123", email: "jane@example.com" });
    const otherAdvisor = makeAdvisor({
      advisor_id: 9,
      auth_user_id: "user-999",
      email: "jane@example.com",
    });
    query.maybeSingle.mockResolvedValue({ data: otherAdvisor, error: null });

    await expect(getCurrentAdvisor(user)).resolves.toBeNull();
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("never consults the user email to resolve the advisor", async () => {
    // Even with a mixed-case/whitespace email, resolution is purely by
    // auth_user_id; no ilike/eq email filters are ever built.
    const user = makeUser({
      id: "user-123",
      email: "  Jane.Doe@Example.COM  ",
    });
    const advisor = makeAdvisor({ advisor_id: 7, auth_user_id: "user-123" });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(getCurrentAdvisor(user)).resolves.toEqual(advisor);
    expect(query.eq).toHaveBeenCalledWith("auth_user_id", "user-123");
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
  });

  it("returns the pre-bound advisor even when the user has no email", async () => {
    const user = makeUser({ id: "user-123", email: undefined });
    const advisor = makeAdvisor({ advisor_id: 5, auth_user_id: "user-123" });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(getCurrentAdvisor(user)).resolves.toEqual(advisor);
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });
});

// ── isOcfAdmin ──────────────────────────────────────────────────────────────
//
// The ONLY administrator authority for lifecycle transitions (entity
// lifecycle archiving): true iff the session user carries the immutable Auth
// JWT `app_metadata.ocf_admin = true` claim. The mutable
// `public.advisor.role` column is never consulted.

describe("isOcfAdmin", () => {
  it("returns false when there is no session user", () => {
    expect(isOcfAdmin(null)).toBe(false);
    expect(isOcfAdmin(undefined)).toBe(false);
  });

  it("returns false when app_metadata is empty", () => {
    expect(isOcfAdmin(makeUser({ app_metadata: {} }))).toBe(false);
  });

  it("returns false when the ocf_admin claim is missing", () => {
    expect(isOcfAdmin(makeUser({ app_metadata: { role: "admin" } }))).toBe(false);
  });

  it("returns false when the ocf_admin claim is false or not the boolean true", () => {
    expect(isOcfAdmin(makeUser({ app_metadata: { ocf_admin: false } }))).toBe(false);
    // A string claim is not the trusted boolean true (the DB boundary compares
    // the JWT text 'true', but the session helper must stay strict too).
    expect(isOcfAdmin(makeUser({ app_metadata: { ocf_admin: "true" } }))).toBe(false);
  });

  it("returns true only when the immutable ocf_admin app_metadata claim is the boolean true", () => {
    expect(isOcfAdmin(makeUser({ app_metadata: { ocf_admin: true } }))).toBe(true);
  });
});

// ── requireAdvisor ──────────────────────────────────────────────────────────

describe("requireAdvisor", () => {
  it("redirects to /login when there is no session user", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: null,
      error: new Error("no session"),
    });

    await expect(requireAdvisor()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login?reason=unauthorized when no advisor is found", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({ data: { user: makeUser() }, error: null });
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(requireAdvisor()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login?reason=unauthorized");
  });

  it("redirects to /login?reason=inactive when the advisor is inactive", async () => {
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({ data: { user: makeUser() }, error: null });
    query.maybeSingle.mockResolvedValue({
      data: makeAdvisor({ auth_user_id: "user-123", is_active: false }),
      error: null,
    });

    await expect(requireAdvisor()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login?reason=inactive");
  });

  it("returns the active advisor without redirecting", async () => {
    const advisor = makeAdvisor({ auth_user_id: "user-123", is_active: true });
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({ data: { user: makeUser() }, error: null });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(requireAdvisor()).resolves.toEqual(advisor);
    expect(redirect).not.toHaveBeenCalled();
  });
});
// ── Effective Admin (migration 20261001000001) ─────────────────────────────
//
// Effective Admin authority = the trusted boolean `app_metadata.ocf_admin`
// claim AND a current, active, pre-bound advisor identity. The mutable
// `advisor.role` display column is never consulted.

describe("AdvisorRole vocabulary", () => {
  it("exposes exactly the Admin and Advisor display roles", () => {
    expect(ADVISOR_ROLES).toEqual(["Admin", "Advisor"]);
  });

  it("classifies the role values strictly (case-sensitive)", () => {
    expect(isAdvisorRole("Admin")).toBe(true);
    expect(isAdvisorRole("Advisor")).toBe(true);
    expect(isAdvisorRole("admin")).toBe(false);
    expect(isAdvisorRole("advisor")).toBe(false);
    expect(isAdvisorRole("Staff")).toBe(false);
    expect(isAdvisorRole(undefined)).toBe(false);
    expect(isAdvisorRole(null)).toBe(false);
  });
});

describe("isEffectiveAdmin (claim + active bound advisor)", () => {
  it("returns false with no session user", () => {
    expect(isEffectiveAdmin(null, makeAdvisor({ is_active: true }))).toBe(false);
    expect(isEffectiveAdmin(undefined, makeAdvisor({ is_active: true }))).toBe(false);
  });

  it("returns false when the claim is missing even with an active advisor", () => {
    expect(isEffectiveAdmin(makeUser({ app_metadata: {} }), makeAdvisor({ is_active: true }))).toBe(false);
  });

  it("returns false when the advisor is missing or not pre-bound", () => {
    expect(isEffectiveAdmin(makeUser({ app_metadata: { ocf_admin: true } }), null)).toBe(false);
    expect(isEffectiveAdmin(makeUser({ app_metadata: { ocf_admin: true } }), undefined)).toBe(false);
  });

  it("returns false when the bound advisor is inactive (deactivated admin)", () => {
    expect(
      isEffectiveAdmin(makeUser({ app_metadata: { ocf_admin: true } }), makeAdvisor({ is_active: false }))
    ).toBe(false);
  });

  it("returns true only for the boolean claim plus an active bound advisor", () => {
    expect(
      isEffectiveAdmin(makeUser({ app_metadata: { ocf_admin: true } }), makeAdvisor({ is_active: true }))
    ).toBe(true);
    // A string claim is never the trusted boolean true.
    expect(
      isEffectiveAdmin(makeUser({ app_metadata: { ocf_admin: "true" } }), makeAdvisor({ is_active: true }))
    ).toBe(false);
  });
});

describe("getEffectiveAdmin (server route gate)", () => {
  it("returns the active bound advisor for a claim-bearing session", async () => {
    const user = makeUser({ id: "user-123", app_metadata: { ocf_admin: true } });
    const advisor = makeAdvisor({ advisor_id: 7, auth_user_id: "user-123", is_active: true });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(getEffectiveAdmin(user)).resolves.toEqual(advisor);
    expect(query.eq).toHaveBeenCalledWith("auth_user_id", "user-123");
  });

  it("returns null when the session user lacks the claim (no advisor lookup)", async () => {
    const user = makeUser({ id: "user-123", app_metadata: {} });

    await expect(getEffectiveAdmin(user)).resolves.toBeNull();
    expect(query.maybeSingle).not.toHaveBeenCalled();
  });

  it("returns null when the bound advisor is inactive", async () => {
    const user = makeUser({ id: "user-123", app_metadata: { ocf_admin: true } });
    query.maybeSingle.mockResolvedValue({
      data: makeAdvisor({ advisor_id: 7, auth_user_id: "user-123", is_active: false }),
      error: null,
    });

    await expect(getEffectiveAdmin(user)).resolves.toBeNull();
  });

  it("returns null when no advisor is bound to the session", async () => {
    const user = makeUser({ id: "user-123", app_metadata: { ocf_admin: true } });
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getEffectiveAdmin(user)).resolves.toBeNull();
  });

  it("resolves through getSessionUser when no session user is passed", async () => {
    const user = makeUser({ id: "user-123", app_metadata: { ocf_admin: true } });
    client.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "user-123" } },
      error: null,
    } as never);
    client.auth.getUser.mockResolvedValue({ data: { user }, error: null });
    const advisor = makeAdvisor({ advisor_id: 7, auth_user_id: "user-123", is_active: true });
    query.maybeSingle.mockResolvedValue({ data: advisor, error: null });

    await expect(getEffectiveAdmin()).resolves.toEqual(advisor);
  });
});
