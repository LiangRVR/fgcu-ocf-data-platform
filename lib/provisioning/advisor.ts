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
import { randomUUID } from "node:crypto";
import type { Database } from "@/types/database";
import type { AdvisorRole } from "@/lib/auth/session";

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
}

/** Input for `setAdvisorRole`: an Admin-only role change on a bound advisor. */
export interface SetAdvisorRoleInput {
  advisorId: number;
  role: AdvisorRole;
}

export type SetRoleFailureCode =
  | "advisor_not_found"
  | "not_bound"
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

/**
 * Result of the explicit durable recovery (`recoverAdvisorRoleChange`): the
 * display role was re-aligned to the authoritative Auth claim (or confirmed
 * already aligned), so no claim/display mismatch remains.
 */
export interface RecoverAdvisorRoleChangeResult {
  ok: boolean;
  advisorId: number;
  /** The display role after reconciliation; null when nothing needed reconciling. */
  role: AdvisorRole | null;
  /** True when the display role was actually changed to match the claim. */
  changed: boolean;
  code?: "lock_busy" | "lock_failed" | "reconciliation_required";
  /** Generic, secret-free message for failures. */
  message?: string;
}

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
const ROLE_CHANGE_LOCK_BUSY_MESSAGE =
  "Another role change is already in progress for this advisor. Please try again later.";
const ROLE_CHANGE_LOCK_FAILED_MESSAGE =
  "Unable to secure the advisor role-change lock. Please try again later.";
const ROLE_CHANGE_RECONCILIATION_REQUIRED_MESSAGE =
  "The advisor role change could not be confirmed; an OCF administrator must reconcile this advisor. No change was guessed.";
const ROLE_CHANGE_DISPLAY_FAILED_MESSAGE =
  "Unable to update the advisor role. Please try again later.";

/** Per-advisor role-change lease duration (seconds): bounds stale-lock recovery. */
const ROLE_CHANGE_LEASE_SECONDS = 60;

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
    // matching display role, ACTIVE by default. Trusted session: the
    // one-time-bind, lifecycle, and role-display guards permit this INSERT.
    const displayName = input.name?.trim() || input.email.split("@")[0] || "Advisor";
    const createdRow = await this.safeRun(() =>
      this.admin
        .from("advisor")
        .insert({
          advisor_name: displayName,
          email: input.email,
          auth_user_id: authUserId,
          is_active: true,
          role,
        })
        .select("advisor_id, role")
        .single(),
    );

    if (
      createdRow.ok &&
      !createdRow.value.error &&
      createdRow.value.data !== null &&
      createdRow.value.data.role === role
    ) {
      return {
        ok: true,
        advisorId: createdRow.value.data.advisor_id,
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
   * Because the claim and display are written in a single transaction, a
   * claim/display mismatch is IMPOSSIBLE: the transaction commits with both
   * consistent or aborts with neither changed. No external GoTrue Auth Admin
   * write is used by this flow (the old lease/fencing/saga machinery is
   * retired), so no network/lease timing can leave drift.
   *
   * Error mapping (the RPC raises distinct SQLSTATEs; the transaction is
   * atomic, so a failure changes NOTHING):
   *   - P0002  -> `advisor_not_found` (the advisor row does not exist);
   *   - 42501  -> `not_bound` (the advisor is not bound to an Auth identity);
   *   - anything else (incl. an unknown/network failure) -> `role_update_failed`
   *     (safe: the atomic transaction either fully applied — consistent — or
   *     did not apply at all).
   *
   * Never touches `auth_user_id` (no rebind), `is_active`, or history; takes
   * effect for the target after a JWT refresh (the claim is stored now).
   */
  async setAdvisorRole(input: SetAdvisorRoleInput): Promise<SetRoleResult> {
    const result = await this.safeRun(() =>
      this.admin.rpc("set_advisor_role", {
        p_advisor_id: input.advisorId,
        p_role: input.role,
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
   * Explicit durable recovery for a claim/display mismatch left by a crashed
   * or expired role-change operation: acquire a fresh per-advisor lease, align
   * the protected display role to the AUTHORITATIVE Auth claim, and release.
   * Returns whether the display changed and the resulting role. This is the
   * trusted recovery for `reconciliation_required` / post-crash states; it
   * never touches the Auth claim, `auth_user_id`, `is_active`, or history, and
   * it skips (lock_busy) when another holder owns an ACTIVE lease.
   */
  async recoverAdvisorRoleChange(advisorId: number): Promise<RecoverAdvisorRoleChangeResult> {
    const holder = randomUUID();

    const acquired = await this.acquireAdvisorRoleLock(advisorId, holder, ROLE_CHANGE_LEASE_SECONDS);
    if (!acquired.ok) {
      return {
        ok: false,
        advisorId,
        role: null,
        changed: false,
        code: "lock_failed",
        message: ROLE_CHANGE_LOCK_FAILED_MESSAGE,
      };
    }
    if (!acquired.value) {
      return {
        ok: false,
        advisorId,
        role: null,
        changed: false,
        code: "lock_busy",
        message: ROLE_CHANGE_LOCK_BUSY_MESSAGE,
      };
    }

    try {
      // Read the current display BEFORE reconciliation (we own the lease).
      const before = await this.safeRun(() =>
        this.admin
          .from("advisor")
          .select("advisor_id, role")
          .eq("advisor_id", advisorId)
          .maybeSingle(),
      );
      if (!before.ok || before.value.error || before.value.data === null) {
        return {
          ok: false,
          advisorId,
          role: null,
          changed: false,
          code: "reconciliation_required",
          message: ROLE_CHANGE_RECONCILIATION_REQUIRED_MESSAGE,
        };
      }

      const reconciled = await this.reconcileAdvisorRoleDisplay(advisorId, holder);
      if (!reconciled.ok || reconciled.role === null) {
        return {
          ok: false,
          advisorId,
          role: null,
          changed: false,
          code: "reconciliation_required",
          message: ROLE_CHANGE_RECONCILIATION_REQUIRED_MESSAGE,
        };
      }

      const beforeRole: AdvisorRole =
        before.value.data.role === "Admin" ? "Admin" : "Advisor";
      return {
        ok: true,
        advisorId,
        role: reconciled.role,
        changed: beforeRole !== reconciled.role,
      };
    } finally {
      await this.releaseAdvisorRoleLock(advisorId, holder);
    }
  }

  /**
   * Acquire the per-advisor role-change lease via the database RPC. Returns
   * `{ ok: false }` when the lock call itself fails (unknown state → fail
   * without mutation); `{ ok: true, value: boolean }` carries whether this
   * holder now owns the lease (false = a different holder owns an ACTIVE
   * lease).
   */
  private async acquireAdvisorRoleLock(
    advisorId: number,
    holder: string,
    leaseSeconds: number,
  ): Promise<{ ok: boolean; value: boolean }> {
    const result = await this.safeRun(() =>
      this.admin.rpc("acquire_advisor_role_lock", {
        p_advisor_id: advisorId,
        p_holder: holder,
        p_lease_seconds: leaseSeconds,
      }),
    );
    if (!result.ok || result.value.error) {
      return { ok: false, value: false };
    }
    return { ok: true, value: result.value.data === true };
  }

  /** Release the per-advisor lease by holder (best-effort; the lease bounds recovery). */
  private async releaseAdvisorRoleLock(advisorId: number, holder: string): Promise<void> {
    await this.safeRun(() =>
      this.admin.rpc("release_advisor_role_lock", {
        p_advisor_id: advisorId,
        p_holder: holder,
      }),
    );
  }

  /**
   * Lease-fenced display-role reconciliation: the database re-aligns
   * `advisor.role` to the AUTHORITATIVE Auth claim (never consults the display
   * for authorization) while THIS holder owns a non-expired lease. Returns
   * `{ ok: false }` when the call fails (unverifiable); `role: null` when the
   * holder no longer owns the lease.
   */
  private async reconcileAdvisorRoleDisplay(
    advisorId: number,
    holder: string,
  ): Promise<{ ok: true; role: AdvisorRole | null } | { ok: false }> {
    const result = await this.safeRun(() =>
      this.admin.rpc("reconcile_advisor_role_display", {
        p_advisor_id: advisorId,
        p_holder: holder,
      }),
    );
    if (!result.ok || result.value.error) {
      return { ok: false };
    }
    const role = result.value.data;
    if (role === null || role === undefined) {
      return { ok: true, role: null };
    }
    if (role === "Admin" || role === "Advisor") {
      return { ok: true, role };
    }
    return { ok: false };
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