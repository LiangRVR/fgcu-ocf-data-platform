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
import type { Database } from "@/types/database";

/** The subset of the Supabase service-role client this adapter needs. */
export type AdminClient = Pick<SupabaseClient<Database>, "auth" | "from">;

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