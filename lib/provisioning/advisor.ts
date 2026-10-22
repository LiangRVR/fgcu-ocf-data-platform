/**
 * lib/provisioning/advisor.ts
 *
 * Server-only advisor provisioning adapter (injectable).
 *
 * Identity binding is admin-only (R11). An administrator provisions an
 * invited/created auth account and conditionally binds it to the chosen
 * `public.advisor` row — ONLY while that row is still unbound
 * (`auth_user_id IS NULL`). There is no email self-link, no self-link RPC, and
 * no fallback to an unlinked email-matched row: this adapter never binds or
 * authorizes an authenticated caller by email.
 *
 * Human attribution (R1, R5): provisioning and role changes forward the
 * ROUTE-RESOLVED effective-Admin advisor id (`actorAdvisorId` / `p_actor_id`)
 * into the trusted database operations, which REVALIDATE it against the
 * durable active/bound Admin state before writing the human-attributed audit
 * event in the same transaction. Actor identity is never a browser payload:
 * no Service/API request accepts an actor id from the client.
 *
 * Safe-saga behavior (amendment A2):
 *   - thrown Admin/DB rejections are normalized to the same generic
 *     `ProvisionFailure` as returned `{ error }` values;
 *   - a bind is accepted ONLY as an EXACT verification: the returned or
 *     read-back row must match both the requested `advisor_id` and the
 *     expected auth UUID — missing UUIDs are never synthesized and wrong
 *     IDs/UUIDs are never accepted;
 *   - EVERY non-verified bind outcome (thrown rejection, returned error,
 *     zero rows, malformed/wrong response) is resolved by an exact read-back
 *     on the advisor id and expected auth UUID, so a committed-but-response-
 *     lost bind returns idempotent success rather than a false failure;
 *   - where the invited/created identity is definitively unbound (or its
 *     advisor row is missing) and THIS saga created it, cleanup is attempted
 *     by the EXACT returned user id only (best-effort); cleanup failure is
 *     tolerated and reported generically — it never falls back to email and
 *     never grants access, and it only ever runs for confirmed unbound/missing
 *     rows;
 *   - every result is generic and secret-free.
 *
 * The Admin client (service-role / GoTrue Admin API) is injected, so tests
 * substitute a mock and real provisioning NEVER executes in tests. This module
 * never logs secrets: every failure surfaces as a generic message.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { AdvisorRole } from "@/lib/auth/session";
import { STALE_VERSION_GUIDANCE } from "@/lib/supabase/errors";

/** The subset of the Supabase service-role client this adapter needs. */
export type AdminClient = Pick<SupabaseClient<Database>, "auth" | "from" | "rpc">;

export interface ProvisionAdvisorInput {
  /** Administrator-chosen advisor row to bind (never resolved by email). */
  advisorId: number;
  /** Intended login email for the invited/created auth account. */
  email: string;
  /** Optional display name forwarded to the auth user record. */
  name?: string;
}

export type ProvisionFailureCode =
  | "invite_failed"
  | "create_failed"
  | "advisor_not_found"
  | "already_bound"
  | "bind_failed";

export interface ProvisionFailure {
  ok: false;
  code: ProvisionFailureCode;
  /** Generic, secret-free message. */
  message: string;
}

export interface ProvisionSuccess {
  ok: true;
  advisorId: number;
  authUserId: string;
  /** true when this call created the auth account; false for bind-existing. */
  created: boolean;
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

/**
 * Role-aware provisioning result: the desired display role was written and the
 * matching Auth `app_metadata.ocf_admin` claim was set.
 */
export interface ProvisionRoleSuccess extends ProvisionSuccess {
  role: AdvisorRole;
}

/**
 * Role-aware provisioning input for `provisionAdvisor`: creates/invites the
 * Auth identity, creates the advisor record bound to it (matching display
 * role, active by default), and sets the matching Auth claim.
 *
 * `actorAdvisorId` is NEVER client input: it is the route-resolved effective
 * Admin advisor id (the authenticated, active, pre-bound administrator who
 * initiates provisioning). The adapter forwards it into the trusted
 * service-role `provision_advisor` RPC (`p_actor_id`), where the database
 * revalidates that the supplied id is a current active bound durable
 * effective Admin before writing the human-attributed `created` audit event
 * in the SAME transaction as the committed advisor row. A browser payload can
 * never supply actor identity.
 */
export interface RoleAwareProvisionInput {
  /** Intended login email for the invited/created auth account. */
  email: string;
  /** Optional display name for the advisor record (defaults to the email local part). */
  name?: string;
  /** Desired operational role; defaults to `Advisor`. */
  role?: AdvisorRole;
  /** `invite` (email invite) or `create` (controlled account); defaults to `invite`. */
  method?: "invite" | "create";
  /**
   * Server-resolved effective-Admin advisor id initiating this provisioning
   * (positive `advisor_id` from `getEffectiveAdmin`, never a payload field).
   */
  actorAdvisorId: number;
}

/**
 * Input for `setAdvisorRole`: an Admin-only role change on a bound advisor.
 *
 * The trusted service-role RPC contract is: target advisor id + new role +
 * verified actor id + reason + the target's expected row version
 * (`p_advisor_id`, `p_role`, `p_actor_id`, `p_reason`, `p_expected_version`).
 * `actorAdvisorId` is the route-resolved effective-Admin advisor id (never
 * client input) and is revalidated inside the RPC; `reason` is a required
 * non-blank human reason forwarded verbatim (trimmed); `expectedVersion` is the
 * target's loaded `row_version` (a stale value is rejected with `PT409`).
 */
export interface SetAdvisorRoleInput {
  /** Target bound advisor whose protected display role/claim changes. */
  advisorId: number;
  /** Desired role; must be exactly `Admin` or `Advisor`. */
  role: AdvisorRole;
  /** Server-resolved effective-Admin advisor id performing the change. */
  actorAdvisorId: number;
  /** Required non-blank human reason for the role change. */
  reason: string;
  /** Target's loaded row version; the RPC rejects a stale value with `PT409`. */
  expectedVersion: number;
}

export type SetRoleFailureCode =
  | "advisor_not_found"
  | "not_bound"
  | "stale_version"
  | "role_update_failed";

export interface SetRoleSuccess {
  ok: true;
  advisorId: number;
  role: AdvisorRole;
  authUserId: string;
}

export interface SetRoleFailure {
  ok: false;
  code: SetRoleFailureCode;
  /** Generic, secret-free message. */
  message: string;
}

export type SetRoleResult = SetRoleSuccess | SetRoleFailure;

/** Generic failure copy — never echoes provider internals, emails, or keys. */
const INVITE_FAILED_MESSAGE =
  "Unable to invite the user for this advisor. Please try again later.";
const CREATE_FAILED_MESSAGE =
  "Unable to create the user for this advisor. Please try again later.";
const BIND_FAILED_MESSAGE =
  "Unable to bind the advisor account. Please try again later.";
const BIND_FAILED_CLEANUP_FAILED_MESSAGE =
  "Unable to bind the advisor account, and the pending account could not be cleaned up. Please contact support.";
const ADVISOR_NOT_FOUND_MESSAGE =
  "The advisor row could not be found.";
const ADVISOR_NOT_FOUND_CLEANUP_FAILED_MESSAGE =
  "The advisor row could not be found, and the pending account could not be cleaned up. Please contact support.";
const ALREADY_BOUND_MESSAGE =
  "This advisor account is already bound.";
const ROLE_CHANGE_ADVISOR_NOT_FOUND_MESSAGE =
  "The advisor row could not be found.";
const ROLE_CHANGE_NOT_BOUND_MESSAGE =
  "The advisor account is not bound to an Auth identity, so its role cannot be changed.";
const ROLE_CHANGE_DISPLAY_FAILED_MESSAGE =
  "Unable to update the advisor role. Please try again later.";
const ROLE_CHANGE_STALE_MESSAGE = STALE_VERSION_GUIDANCE;
const ROLE_CHANGE_REASON_REQUIRED_MESSAGE =
  "A non-blank reason is required for an advisor role change.";
const PROVISION_ACTOR_REQUIRED_MESSAGE =
  "The advisor provisioning request could not be attributed to an active administrator.";

export class AdvisorProvisioning {
  constructor(private readonly admin: AdminClient) {}

  /**
   * Invite a NEW auth user for `input.email` via the Admin API, capture the
   * returned user id, then conditionally bind it to the chosen advisor row
   * while unbound. If the invite fails — a returned `{ error }` OR a thrown
   * Admin rejection — the operation fails generically (A2); it NEVER falls
   * back to email-based binding.
   */
  async inviteAndBind(input: ProvisionAdvisorInput): Promise<ProvisionResult> {
    const invited = await this.safeRun(() =>
      this.admin.auth.admin.inviteUserByEmail(
        input.email,
        input.name ? { data: { advisor_name: input.name } } : undefined,
      ),
    );

    if (!invited.ok) {
      return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
    }
    const { data, error } = invited.value;
    if (error) {
      return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
    }
    const authUserId = data?.user?.id;
    if (!authUserId) {
      return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
    }

    return this.bindUnbound(input.advisorId, authUserId);
  }

  /**
   * Create a controlled NEW auth user for `input.email` via the Admin API,
   * capture the returned user id, then conditionally bind it to the chosen
   * advisor row while unbound. A returned `{ error }` OR a thrown Admin
   * rejection fails generically (A2) — never email-based.
   */
  async createAndBind(input: ProvisionAdvisorInput): Promise<ProvisionResult> {
    const created = await this.safeRun(() =>
      this.admin.auth.admin.createUser({
        email: input.email,
        email_confirm: false,
        user_metadata: input.name ? { advisor_name: input.name } : undefined,
      }),
    );

    if (!created.ok) {
      return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
    }
    const { data, error } = created.value;
    if (error) {
      return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
    }
    const authUserId = data?.user?.id;
    if (!authUserId) {
      return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
    }

    return this.bindUnbound(input.advisorId, authUserId);
  }

  /**
   * Bind an ALREADY-EXISTING auth account to the chosen advisor row by its
   * exact auth UUID (verified administrator path). No email is involved.
   */
  async bindExisting(input: {
    advisorId: number;
    authUserId: string;
  }): Promise<ProvisionResult> {
    return this.bindUnbound(input.advisorId, input.authUserId, false);
  }

  /**
   * Role-aware provisioning (effective-Admin API path): create or invite the
   * Auth identity with the `app_metadata.ocf_admin` boolean claim MATCHING the
   * desired role, then create the advisor record bound to that identity (the
   * matching protected display role, ACTIVE by default) through the trusted
   * session. No email is ever used as an authorization key — the binding is the
   * exact returned auth UUID written at INSERT (the one-time-bind guard allows
   * this trusted INSERT path), and it never rebinds an existing `auth_user_id`.
   *
   * A failed or non-verified advisor insert is resolved by an exact read-back
   * on the bound auth UUID (a committed-but-response-lost insert converges to
   * success). When the advisor record is definitively missing/unverifiable,
   * the identity THIS flow created is cleaned up best-effort by its exact user
   * id before the generic failure is returned — a successful UI response is
   * never emitted for a partially-provisioned state.
   */
  async provisionAdvisor(
    input: RoleAwareProvisionInput,
  ): Promise<ProvisionRoleSuccess | ProvisionFailure> {
    // Fail fast when the trusted server actor is missing/malformed. The
    // actor advisor id is always route-resolved (`getEffectiveAdmin`), so a
    // violation here is a server-contract bug that must fail generically
    // BEFORE any Auth side effect (invite/create/bind) runs.
    if (!Number.isInteger(input.actorAdvisorId) || input.actorAdvisorId <= 0) {
      return { ok: false, code: "bind_failed", message: PROVISION_ACTOR_REQUIRED_MESSAGE };
    }

    const role = input.role === "Admin" ? "Admin" : "Advisor";
    const claim = role === "Admin";
    const method = input.method ?? "invite";

    // Step 1 — create/invite the Auth identity with the matching claim.
    let authUserId: string;
    if (method === "create") {
      const created = await this.safeRun(() =>
        this.admin.auth.admin.createUser({
          email: input.email,
          email_confirm: false,
          user_metadata: input.name ? { advisor_name: input.name } : undefined,
          app_metadata: { ocf_admin: claim },
        }),
      );
      if (!created.ok) {
        return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
      }
      const { data, error } = created.value;
      if (error) {
        return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
      }
      authUserId = data?.user?.id ?? "";
      if (!authUserId) {
        return { ok: false, code: "create_failed", message: CREATE_FAILED_MESSAGE };
      }
    } else {
      // Invite first (GoTrue's invite API has no app_metadata argument), then
      // set the matching Auth claim on the invited identity by exact user id.
      const invited = await this.safeRun(() =>
        this.admin.auth.admin.inviteUserByEmail(
          input.email,
          input.name ? { data: { advisor_name: input.name } } : undefined,
        ),
      );
      if (!invited.ok) {
        return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
      }
      const { data, error } = invited.value;
      if (error) {
        return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
      }
      authUserId = data?.user?.id ?? "";
      if (!authUserId) {
        return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
      }

      const claimSet = await this.safeRun(() =>
        this.admin.auth.admin.updateUserById(authUserId, {
          app_metadata: { ocf_admin: claim },
        }),
      );
      if (!claimSet.ok || claimSet.value.error) {
        // The invited identity would be bound without the matching claim —
        // compensate by deleting the exact invited identity (best-effort).
        await this.safeRun(() => this.admin.auth.admin.deleteUser(authUserId));
        return { ok: false, code: "invite_failed", message: INVITE_FAILED_MESSAGE };
      }
    }

    // Step 2 — create the advisor record bound to the new identity, in the
    // matching display role, ACTIVE by default, attributed to the verified
    // effective-Admin actor. The trusted path is the service-role-only
    // SECURITY DEFINER `provision_advisor(p_actor_id, p_advisor_name,
    // p_email, p_auth_user_id, p_role)` RPC: it revalidates the supplied
    // actor as a durable effective Admin, sets transaction-local audit
    // context, and INSERTs the advisor row in the SAME transaction — so the
    // advisor audit trigger writes exactly one `created` event attributed to
    // that Admin (never System for a normal Admin provisioning), while the
    // one-time-bind/lifecycle/role-display guards still apply.
    const displayName = input.name?.trim() || input.email.split("@")[0] || "Advisor";
    const createdRow = await this.safeRun(() =>
      this.admin.rpc("provision_advisor", {
        p_actor_id: input.actorAdvisorId,
        p_advisor_name: displayName,
        p_email: input.email,
        p_auth_user_id: authUserId,
        p_role: role,
      }),
    );

    // Direct success requires an EXACT returned row: the trusted RPC must
    // return a row whose role and bound auth UUID match EXACTLY what this
    // flow created/requested. A thrown rejection, a returned error, or a
    // malformed/missing row is NOT a verified creation.
    const createdResult =
      createdRow.ok && !createdRow.value.error ? createdRow.value.data?.[0] : undefined;
    if (
      createdResult &&
      Number.isInteger(createdResult.advisor_id) &&
      createdResult.advisor_id > 0 &&
      createdResult.role === role &&
      createdResult.auth_user_id === authUserId
    ) {
      return {
        ok: true,
        advisorId: createdResult.advisor_id,
        authUserId,
        created: true,
        role,
      };
    }

    // Non-verified insert: read back by the EXACT bound auth UUID before
    // deciding (a committed-but-response-lost insert converges to success).
    const existing = await this.safeRun(() =>
      this.admin
        .from("advisor")
        .select("advisor_id, role")
        .eq("auth_user_id", authUserId)
        .maybeSingle(),
    );
    if (
      existing.ok &&
      !existing.value.error &&
      existing.value.data !== null &&
      existing.value.data.role === role
    ) {
      return {
        ok: true,
        advisorId: existing.value.data.advisor_id,
        authUserId,
        created: true,
        role,
      };
    }

    // The advisor record is definitively missing/unverifiable: best-effort
    // cleanup of the identity this flow created, then fail generically.
    return this.failAfterCleanup(
      authUserId,
      "bind_failed",
      BIND_FAILED_MESSAGE,
      BIND_FAILED_CLEANUP_FAILED_MESSAGE,
    );
  }

  /**
   * Admin-only role change for an ALREADY-BOUND advisor, implemented as a
   * NARROW service-role-only SECURITY DEFINER database RPC
   * (`set_advisor_role`) that atomically updates the trusted Auth claim
   * (`auth.users.raw_app_meta_data.ocf_admin` JSON boolean) AND the protected
   * `public.advisor.role` display projection in ONE Postgres transaction.
   *
   * The RPC contract is actor-and-reason-aware (approved plan step 2 /
   * design point 4): `p_advisor_id` (target advisor), `p_role` (new role),
   * `p_actor_id` (the VERIFIED server-resolved effective-Admin advisor id —
   * revalidated inside the RPC against the durable Auth metadata + active
   * bound advisor state), a required non-blank `p_reason`, and
   * `p_expected_version` (the target's loaded `row_version`). It serializes
   * final-effective-Admin removal, rejects a stale expected version with
   * `PT409` BEFORE any claim/display change, and emits exactly one
   * `role_changed` audit event in the same transaction. The adapter enforces
   * the non-blank reason, a positive actor id, and a positive expected version
   * BEFORE the call (defense in depth; the RPC is authoritative).
   *
   * Because the claim and display are written in a single transaction, a
   * claim/display mismatch is IMPOSSIBLE: the transaction commits with both
   * consistent or aborts with neither changed. No external GoTrue Auth Admin
   * write is used by this flow (the old lease/fencing/saga machinery is
   * retired), so no network/lease timing can leave drift.
   *
   * Error mapping (the RPC raises distinct SQLSTATEs; the transaction is
   * atomic, so a failure changes NOTHING):
   *   - P0002  -> `advisor_not_found` (the advisor row does not exist);
   *   - 42501  -> `not_bound` (the advisor is not bound to an Auth identity;
   *               this also covers an invalid/unverified trusted actor);
   *   - PT409  -> `stale_version` (the expected version is stale; no change);
   *   - anything else (incl. an unknown/network failure) -> `role_update_failed`
   *     (safe: the atomic transaction either fully applied — consistent — or
   *     did not apply at all).
   *
   * Never touches `auth_user_id` (no rebind), `is_active`, or history; takes
   * effect for the target after a JWT refresh (the claim is stored now).
   */
  async setAdvisorRole(input: SetAdvisorRoleInput): Promise<SetRoleResult> {
    // Fail fast on a missing/blank reason and a malformed trusted actor
    // BEFORE the RPC (defense in depth; the route schema enforces these, and
    // the RPC remains authoritative). Both failures are generic and secret-
    // free; the atomic RPC never runs, so nothing changes.
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "role_update_failed",
        message: ROLE_CHANGE_REASON_REQUIRED_MESSAGE,
      };
    }
    if (!Number.isInteger(input.actorAdvisorId) || input.actorAdvisorId <= 0) {
      return {
        ok: false,
        code: "role_update_failed",
        message: ROLE_CHANGE_DISPLAY_FAILED_MESSAGE,
      };
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      return {
        ok: false,
        code: "role_update_failed",
        message: ROLE_CHANGE_DISPLAY_FAILED_MESSAGE,
      };
    }

    const result = await this.safeRun(() =>
      this.admin.rpc("set_advisor_role", {
        p_advisor_id: input.advisorId,
        p_role: input.role,
        p_actor_id: input.actorAdvisorId,
        p_reason: reason,
        p_expected_version: input.expectedVersion,
      }),
    );

    if (!result.ok) {
      // The RPC call itself failed (network/unknown). The transaction is
      // atomic: either the claim AND display both changed (consistent) or
      // neither did — a generic failure is safe.
      return {
        ok: false,
        code: "role_update_failed",
        message: ROLE_CHANGE_DISPLAY_FAILED_MESSAGE,
      };
    }
    if (result.value.error) {
      const code = result.value.error.code;
      if (code === "P0002") {
        return { ok: false, code: "advisor_not_found", message: ROLE_CHANGE_ADVISOR_NOT_FOUND_MESSAGE };
      }
      if (code === "42501") {
        return { ok: false, code: "not_bound", message: ROLE_CHANGE_NOT_BOUND_MESSAGE };
      }
      if (code === "PT409") {
        return { ok: false, code: "stale_version", message: ROLE_CHANGE_STALE_MESSAGE };
      }
      return { ok: false, code: "role_update_failed", message: ROLE_CHANGE_DISPLAY_FAILED_MESSAGE };
    }

    const row = result.value.data?.[0];
    if (!row) {
      return { ok: false, code: "role_update_failed", message: ROLE_CHANGE_DISPLAY_FAILED_MESSAGE };
    }

    return {
      ok: true,
      advisorId: row.advisor_id,
      role: input.role,
      authUserId: row.auth_user_id,
    };
  }
  /**
   * Atomic, unbound-only bind. The UPDATE is filtered by
   * `auth_user_id IS NULL`, so a duplicate/retry can never re-bind an
   * already-bound row.
   *
   * A bind is accepted ONLY as an EXACT verification: the returned or
   * read-back row must match both the requested `advisor_id` and the expected
   * auth UUID. Every non-verified outcome — thrown rejection, returned error,
   * 0 rows, or a malformed response (missing/wrong advisor id or UUID) — is
   * resolved by an exact read-back on the advisor id and expected UUID before
   * any failure/cleanup decision, so a committed-but-response-lost bind
   * converges to idempotent success rather than a false failure:
   *   - read-back exact match             → idempotent success (no cleanup);
   *   - advisor row missing               → `advisor_not_found` (+ best-effort
   *     cleanup of a just-created identity by its exact user id);
   *   - row present, still unbound        → `bind_failed` (+ best-effort
   *     cleanup of a just-created identity by its exact user id);
   *   - bound to a different UUID         → `already_bound`, no cleanup;
   *   - read-back unavailable/malformed   → `bind_failed`, no cleanup (state
   *     unknown — cleanup only ever runs for confirmed unbound/missing rows).
   * Missing UUIDs are never synthesized and wrong IDs/UUIDs are never
   * accepted.
   */
  private async bindUnbound(
    advisorId: number,
    authUserId: string,
    created = true,
  ): Promise<ProvisionResult> {
    const bound = await this.safeRun(() =>
      this.admin
        .from("advisor")
        .update({ auth_user_id: authUserId })
        .eq("advisor_id", advisorId)
        .is("auth_user_id", null)
        .select("advisor_id, auth_user_id")
        .maybeSingle(),
    );

    // Direct success requires an EXACT returned-row match on BOTH the
    // requested advisor id and the expected auth UUID. A thrown rejection, a
    // returned error, a null row, or a malformed row (missing/wrong
    // advisor id or UUID) is NOT a verified bind.
    if (
      bound.ok &&
      !bound.value.error &&
      bound.value.data !== null &&
      bound.value.data.advisor_id === advisorId &&
      bound.value.data.auth_user_id === authUserId
    ) {
      return { ok: true, advisorId, authUserId, created };
    }

    // Non-verified bind: read back by advisor id and the expected UUID before
    // deciding failure or cleanup.
    const existing = await this.safeRun(() =>
      this.admin
        .from("advisor")
        .select("advisor_id, auth_user_id")
        .eq("advisor_id", advisorId)
        .maybeSingle(),
    );

    if (!existing.ok || existing.value.error) {
      // Read-back unavailable — bind state unknown: no cleanup, no access.
      return { ok: false, code: "bind_failed", message: BIND_FAILED_MESSAGE };
    }
    if (existing.value.data === null) {
      // Advisor row missing — this saga never bound it.
      if (created) {
        return this.failAfterCleanup(
          authUserId,
          "advisor_not_found",
          ADVISOR_NOT_FOUND_MESSAGE,
          ADVISOR_NOT_FOUND_CLEANUP_FAILED_MESSAGE,
        );
      }
      return { ok: false, code: "advisor_not_found", message: ADVISOR_NOT_FOUND_MESSAGE };
    }

    const row = existing.value.data;
    if (row.advisor_id !== advisorId) {
      // Read-back returned an unexpected advisor row — cannot verify.
      return { ok: false, code: "bind_failed", message: BIND_FAILED_MESSAGE };
    }
    if (row.auth_user_id === authUserId) {
      // Exact read-back match: the bind committed but its response was lost
      // (or this is a zero-row retry after a completed bind) → idempotent
      // success, no cleanup.
      return {
        ok: true,
        advisorId: row.advisor_id,
        authUserId: row.auth_user_id,
        created,
      };
    }
    if (row.auth_user_id === null) {
      // Row is present but STILL unbound: the guarded bind did not take
      // effect. Clean up a just-created identity (best-effort, by its exact
      // user id) and fail — no access is granted.
      if (created) {
        return this.failAfterCleanup(
          authUserId,
          "bind_failed",
          BIND_FAILED_MESSAGE,
          BIND_FAILED_CLEANUP_FAILED_MESSAGE,
        );
      }
      return { ok: false, code: "bind_failed", message: BIND_FAILED_MESSAGE };
    }

    // Bound to a different UUID — already_bound, no cleanup.
    return { ok: false, code: "already_bound", message: ALREADY_BOUND_MESSAGE };
  }

  /**
   * Run a provider operation, normalizing a THROWN rejection into an
   * `{ ok: false }` sentinel so the caller maps it to the same generic
   * failure it would return for a provider `{ error }` (A2).
   */
  private async safeRun<T>(
    operation: () => PromiseLike<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await operation() };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Best-effort cleanup of an identity THIS saga just created but which is
   * definitively unbound. Deletes by the EXACT auth UUID only — never by
   * email. Cleanup failure is tolerated and reported only as a generic
   * message variant; it never falls back to email and never grants access.
   */
  private async failAfterCleanup(
    authUserId: string,
    code: "bind_failed" | "advisor_not_found",
    message: string,
    cleanupFailedMessage: string,
  ): Promise<ProvisionFailure> {
    let cleanupSucceeded = false;
    try {
      const { error } = await this.admin.auth.admin.deleteUser(authUserId);
      cleanupSucceeded = !error;
    } catch {
      cleanupSucceeded = false;
    }

    return {
      ok: false,
      code,
      message: cleanupSucceeded ? message : cleanupFailedMessage,
    };
  }
}