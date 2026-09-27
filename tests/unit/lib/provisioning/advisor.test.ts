/**
 * tests/unit/lib/provisioning/advisor.test.ts
 *
 * Provisioning adapter contract (R11, design §1.2) plus the safe-saga
 * amendment (A2), exercised with a MOCKED Admin client only:
 *
 *   - new invite bind: invite → capture returned `data.user.id` → conditional
 *     bind while unbound (`auth_user_id IS NULL`);
 *   - duplicate/retry: an already-bound row is never re-bound; a retry is
 *     idempotent; an existing-user invite fails generically WITHOUT falling
 *     back to email-based binding;
 *   - pre-existing matching account denied before explicit binding: the
 *     adapter NEVER binds or authorizes by email;
 *   - bind failure: generic error surfaces, the advisor row is unchanged (the
 *     unbound guard prevents any write), and no secret is ever logged.
 *   - safe saga (A2): thrown Admin/DB rejections are normalized to the same
 *     generic failure; a bind is accepted ONLY as an exact verification
 *     (returned/read-back row matches BOTH the requested advisor id and the
 *     expected auth UUID — null/malformed/wrong-advisor/wrong-UUID responses
 *     are rejected); EVERY non-verified bind outcome (thrown, returned error,
 *     zero rows, malformed response) resolves by exact read-back before any
 *     failure/cleanup decision, so a committed-but-response-lost bind returns
 *     idempotent success; a definitively-unbound identity created by this
 *     saga is cleaned up best-effort by its EXACT user id — cleanup success
 *     and failure are both tolerated and reported generically, it never runs
 *     for unverified states, never uses email, and never grants access.
 *
 * Real provisioning NEVER executes here: the Admin client is fully mocked and
 * the factory (which requires the service-role secret) is not used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvisorProvisioning, type AdminClient } from "@/lib/provisioning";

const SECRET_MARKER = "eyJhbGciOiJIUzI1NiIsInNlcnZpY2Vfcm9sZSI6InRlc3Qtc2VjcmV0In0";

/**
 * Builds a chainable fake `.from("advisor")` query builder plus a fake Admin
 * auth API. Both are fully mocked — no network, no service-role key.
 */
function createMockAdmin() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn(),
    single: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });

  const admin = {
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(),
        createUser: vi.fn(),
        deleteUser: vi.fn(),
      },
    },
    from: vi.fn().mockReturnValue(query),
  };

  return { admin, query };
}

let admin: ReturnType<typeof createMockAdmin>["admin"];
let query: ReturnType<typeof createMockAdmin>["query"];
let provisioner: AdvisorProvisioning;

beforeEach(() => {
  vi.clearAllMocks();
  const mock = createMockAdmin();
  admin = mock.admin;
  query = mock.query;
  provisioner = new AdvisorProvisioning(admin as unknown as AdminClient);
});

describe("AdvisorProvisioning.inviteAndBind", () => {
  it("invites the user, captures the returned user id, and binds while unbound", async () => {
    // 1. Admin invite resolves a NEW user with a captured id.
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });

    // 2. The conditional bind update resolves ONE row (the row was unbound).
    query.maybeSingle.mockResolvedValue({
      data: { advisor_id: 42, auth_user_id: "invited-user-1" },
      error: null,
    });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "invited-user-1",
      created: true,
    });

    // The invite used the intended email.
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      "invited@example.com",
      undefined,
    );

    // The bind was a conditional, unbound-only update on the chosen row:
    // `auth_user_id = <captured id>` WHERE `advisor_id = 42` AND
    // `auth_user_id IS NULL`.
    expect(query.update).toHaveBeenCalledWith({ auth_user_id: "invited-user-1" });
    expect(query.eq).toHaveBeenCalledWith("advisor_id", 42);
    expect(query.is).toHaveBeenCalledWith("auth_user_id", null);
  });

  it("passes an optional name through to the invite metadata", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-2" } },
      error: null,
    });
    query.maybeSingle.mockResolvedValue({
      data: { advisor_id: 42, auth_user_id: "invited-user-2" },
      error: null,
    });

    await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
      name: "Invited Advisor",
    });

    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      "invited@example.com",
      { data: { advisor_name: "Invited Advisor" } },
    );
  });

  it("fails generically when the invite errors (e.g. existing user) WITHOUT binding by email", async () => {
    // The Admin invite API rejects the call (user already exists). The adapter
    // must NOT fall back to an email-based match/bind.
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", message: `User already registered: ${SECRET_MARKER}` },
    });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "existing@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "invite_failed",
      message: expect.stringContaining("Unable to invite the user"),
    });
    // The generic message never leaks the provider error (which carried the
    // secret marker).
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));

    // No advisor query ran at all: no email lookup, no bind.
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("fails generically when the invite returns no user", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "missing@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "invite_failed",
      message: expect.stringContaining("Unable to invite the user"),
    });
    expect(admin.from).not.toHaveBeenCalled();
  });
});

describe("AdvisorProvisioning.createAndBind", () => {
  it("creates the user, captures the returned user id, and binds while unbound", async () => {
    admin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: "created-user-1" } },
      error: null,
    });
    query.maybeSingle.mockResolvedValue({
      data: { advisor_id: 42, auth_user_id: "created-user-1" },
      error: null,
    });

    const result = await provisioner.createAndBind({
      advisorId: 42,
      email: "created@example.com",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "created-user-1",
      created: true,
    });
    expect(admin.auth.admin.createUser).toHaveBeenCalledWith({
      email: "created@example.com",
      email_confirm: false,
      user_metadata: undefined,
    });
    expect(query.update).toHaveBeenCalledWith({ auth_user_id: "created-user-1" });
    expect(query.is).toHaveBeenCalledWith("auth_user_id", null);
  });

  it("fails generically when createUser errors", async () => {
    admin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", message: `weak password: ${SECRET_MARKER}` },
    });

    const result = await provisioner.createAndBind({
      advisorId: 42,
      email: "created@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "create_failed",
      message: expect.stringContaining("Unable to create the user"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.from).not.toHaveBeenCalled();
  });
});

describe("AdvisorProvisioning.bindExisting", () => {
  it("binds an existing account by exact uuid and reports created:false", async () => {
    query.maybeSingle.mockResolvedValue({
      data: { advisor_id: 42, auth_user_id: "existing-user-1" },
      error: null,
    });

    const result = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "existing-user-1",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "existing-user-1",
      created: false,
    });
    expect(query.update).toHaveBeenCalledWith({ auth_user_id: "existing-user-1" });
    expect(query.is).toHaveBeenCalledWith("auth_user_id", null);
  });
});

describe("duplicate / retry safety", () => {
  it("never re-binds an advisor row bound to a DIFFERENT UUID (already_bound, no cleanup)", async () => {
    // Pre-bound row: the conditional update matches 0 rows (already bound to
    // another identity), and the read-back finds the row with the OTHER id.
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "other-bound-user" }, error: null });

    const result = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "expected-user",
    });

    expect(result).toEqual({
      ok: false,
      code: "already_bound",
      message: expect.stringContaining("already bound"),
    });

    // The write was guarded by `auth_user_id IS NULL` — a second call cannot
    // re-bind either (idempotent retry).
    expect(query.update).toHaveBeenCalledWith({ auth_user_id: "expected-user" });
    expect(query.is).toHaveBeenCalledWith("auth_user_id", null);

    // already_bound never triggers cleanup of the expected identity.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();

    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "other-bound-user" }, error: null });
    const retry = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "expected-user",
    });
    expect(retry).toEqual(result);
  });

  it("is idempotent: a row already bound to the EXACT expected UUID completes as success", async () => {
    // A prior bind succeeded; the retry's guarded update matches 0 rows and
    // the read-back shows the SAME bound UUID — the end state is exactly the
    // intended one, so the retry converges to success without re-writing.
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "expected-user" }, error: null });

    const result = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "expected-user",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "expected-user",
      created: false,
    });
    // The unbound guard still applied — nothing was re-bound.
    expect(query.update).toHaveBeenCalledWith({ auth_user_id: "expected-user" });
    expect(query.is).toHaveBeenCalledWith("auth_user_id", null);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("reports advisor_not_found when the conditional update matches no row AND no advisor exists", async () => {
    query.maybeSingle
      // First call (the guarded update) → 0 rows.
      .mockResolvedValueOnce({ data: null, error: null })
      // Follow-up existence read → no advisor row.
      .mockResolvedValueOnce({ data: null, error: null });

    const result = await provisioner.bindExisting({
      advisorId: 9999,
      authUserId: "user-1",
    });

    expect(result).toEqual({
      ok: false,
      code: "advisor_not_found",
      message: expect.stringContaining("could not be found"),
    });

    // bindExisting did NOT create the identity, so nothing is cleaned up.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("reports bind_failed when the conditional update errors", async () => {
    // Guarded update itself errors — no partial state, nothing written. The
    // saga still reads back (which also errors here), so the state stays
    // unverifiable → generic bind_failed, no cleanup, no secret.
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: { name: "PostgrestError", message: `write failed: ${SECRET_MARKER}` },
    });

    const result = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "user-1",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("safe saga: thrown Admin/DB errors are normalized (A2)", () => {
  it("normalizes a thrown invite rejection to invite_failed, secret-free", async () => {
    admin.auth.admin.inviteUserByEmail.mockRejectedValue(
      new Error(`invite exploded: ${SECRET_MARKER}`),
    );

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "throw@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "invite_failed",
      message: expect.stringContaining("Unable to invite the user"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    // No advisor query ran: no email lookup, no bind, no cleanup.
    expect(admin.from).not.toHaveBeenCalled();
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("normalizes a thrown create rejection to create_failed, secret-free", async () => {
    admin.auth.admin.createUser.mockRejectedValue(
      new Error(`create exploded: ${SECRET_MARKER}`),
    );

    const result = await provisioner.createAndBind({
      advisorId: 42,
      email: "throw@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "create_failed",
      message: expect.stringContaining("Unable to create the user"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("normalizes a thrown guarded-bind AND a thrown read-back to bind_failed, no cleanup, secret-free", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // The guarded bind throws AND the read-back also throws (persistent
    // rejection) → the state stays unverifiable, so the saga fails generically
    // with NO cleanup (cleanup only runs for confirmed unbound/missing rows).
    query.maybeSingle.mockRejectedValue(
      new Error(`db exploded: ${SECRET_MARKER}`),
    );

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    // The saga still read back (2 calls) before failing, and never escalated
    // into cleanup or email matching.
    expect(query.maybeSingle).toHaveBeenCalledTimes(2);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("reads back after a thrown guarded-bind: exact read-back match → idempotent success", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // The bind committed but its response was LOST (thrown). The read-back
    // proves the exact advisor id + expected UUID → idempotent success, not a
    // false failure.
    query.maybeSingle
      .mockRejectedValueOnce(new Error(`connection dropped: ${SECRET_MARKER}`))
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "invited-user-1" }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "invited-user-1",
      created: true,
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("reads back after a thrown guarded-bind: definitively-unbound read-back → cleanup + bind_failed", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // The bind threw; the read-back proves the row is present but STILL
    // unbound → best-effort cleanup by exact user id + generic failure.
    query.maybeSingle
      .mockRejectedValueOnce(new Error(`connection dropped: ${SECRET_MARKER}`))
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
  });

  it("normalizes a thrown read-back rejection to bind_failed, secret-free", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockRejectedValueOnce(new Error(`read-back exploded: ${SECRET_MARKER}`));

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    // Read-back unavailable → state unknown → no cleanup.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("safe saga: every non-verified bind outcome resolves by exact read-back (A2)", () => {
  it("returns idempotent success when a committed bind's response carries a RETURNED error", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // The guarded UPDATE committed, but the response carried an error. The
    // read-back proves the exact advisor id + expected UUID → idempotent
    // success, not a false failure.
    query.maybeSingle
      .mockResolvedValueOnce({
        data: null,
        error: { name: "PostgrestError", message: `lost response: ${SECRET_MARKER}` },
      })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "invited-user-1" }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: true,
      advisorId: 42,
      authUserId: "invited-user-1",
      created: true,
    });
    // The provider error/secret never leaks even on recovery, and no cleanup
    // runs for a confirmed bound row.
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("rejects a NULL success response: read-back proves definitively unbound → cleanup + failure", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Update returns no row; read-back shows the row present but STILL
    // unbound → not a verified bind → cleanup + generic failure.
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
  });

  it("rejects a MALFORMED success response (auth_user_id null) via exact read-back + cleanup", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Update claims success with a NULL auth_user_id — NOT an exact match, so
    // it is not trusted. Read-back shows the row still unbound → cleanup.
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
  });

  it("rejects a WRONG-ADVISOR success response via exact read-back + cleanup when unbound", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Update claims success for the WRONG advisor_id — not trusted. Read-back
    // (by the requested advisor id) shows the target row still unbound.
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 9999, auth_user_id: "invited-user-1" }, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
  });

  it("rejects a WRONG-UUID success response: read-back proves bound to another → already_bound, no cleanup", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Update claims success with a DIFFERENT auth UUID — not trusted. The
    // read-back confirms the row is bound to another identity.
    query.maybeSingle
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "other-bound-user" }, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "other-bound-user" }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "already_bound",
      message: expect.stringContaining("already bound"),
    });
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("never cleans up when the read-back itself returns an error (state unknown)", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Both the update and the read-back return errors (persistent mock) →
    // unverifiable state → generic failure with NO cleanup.
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: { name: "PostgrestError", message: `read-back failed: ${SECRET_MARKER}` },
    });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("never cleans up when the read-back returns a malformed WRONG-ADVISOR row", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Update returns no row; the read-back returns a row for the WRONG
    // advisor — the requested advisor's state cannot be verified, so the saga
    // fails generically and must NOT delete anything.
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 9999, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("safe saga: zero-row/ambiguous bind read-back (advisor id + expected UUID, A2)", () => {
  it("distinguishes already-bound-to-a-different-UUID from the expected UUID", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    // Guarded update → 0 rows; read-back → row bound to a DIFFERENT uuid.
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: "other-bound-user" }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "already_bound",
      message: expect.stringContaining("already bound"),
    });
    // No cleanup: the row is bound to someone else; the invited identity was
    // never bound but the row is not ours to unbind — and cleanup is only for
    // definitively-unbound identities.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("reports bind_failed when the row is present but STILL unbound (definitively unbound)", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    // No access: the bind never took effect.
    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
  });

  it("does NOT clean up an identity this saga did not create (bindExisting)", async () => {
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.bindExisting({
      advisorId: 42,
      authUserId: "existing-user-1",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });
    // created=false ⇒ no cleanup of the pre-existing account.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("safe saga: best-effort cleanup by exact user id (A2)", () => {
  it("cleans up a definitively-unbound invited identity by its exact user id", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("Unable to bind the advisor account"),
    });

    // Cleanup targeted the EXACT returned user id — never by email.
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
  });

  it("cleans up a created identity when its advisor row is missing", async () => {
    admin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: "created-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: { id: "created-user-1" } },
      error: null,
    });
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const result = await provisioner.createAndBind({
      advisorId: 9999,
      email: "created@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "advisor_not_found",
      message: expect.stringContaining("could not be found"),
    });
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("created-user-1");
  });

  it("tolerates cleanup failure (returned error): generic, secret-free, no email fallback, no access", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", message: `delete failed: ${SECRET_MARKER}` },
    });
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    // Still a generic failure — no access — with a generic cleanup note.
    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("could not be cleaned up"),
    });
    // The provider delete error (which carried the secret marker) is never
    // echoed, and nothing falls back to an email match.
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
  });

  it("tolerates cleanup failure (thrown): generic, secret-free, no email fallback, no access", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "invited-user-1" } },
      error: null,
    });
    admin.auth.admin.deleteUser.mockRejectedValue(
      new Error(`delete exploded: ${SECRET_MARKER}`),
    );
    query.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { advisor_id: 42, auth_user_id: null }, error: null });

    const result = await provisioner.inviteAndBind({
      advisorId: 42,
      email: "invited@example.com",
    });

    expect(result).toEqual({
      ok: false,
      code: "bind_failed",
      message: expect.stringContaining("could not be cleaned up"),
    });
    expect(result).not.toEqual(expect.objectContaining({ message: expect.stringContaining(SECRET_MARKER) }));
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith("invited-user-1");
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
  });
});

describe("never binds or authorizes by email", () => {
  it("the only advisor query ever filters by advisor_id + auth_user_id IS NULL", async () => {
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    query.maybeSingle.mockResolvedValue({
      data: { advisor_id: 42, auth_user_id: "user-1" },
      error: null,
    });

    await provisioner.inviteAndBind({
      advisorId: 42,
      email: "jane@example.com",
    });

    // The email appears only in the Admin invite call — never in an advisor
    // query, and never as a bind/authorization key.
    expect(admin.from).toHaveBeenCalledWith("advisor");
    expect(query.eq).toHaveBeenCalledWith("advisor_id", 42);
    expect(query.eq).not.toHaveBeenCalledWith("email", expect.anything());
    expect(query.eq).not.toHaveBeenCalledWith(
      "auth_user_id",
      "jane@example.com",
    );
    expect(query.eq).not.toHaveBeenCalledWith(
      "auth.uid()",
      expect.anything(),
    );
  });
});