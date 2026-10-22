/**
 * lib/supabase/errors.ts
 *
 * Shared optimistic-concurrency conflict helpers for the protected
 * expected-version writer RPCs (migration
 * `20261015000001_protected_current_state_writers.sql`).
 *
 * A stale `p_expected_version` raises `SQLSTATE 'PT409'`; PostgREST/supabase-js
 * surfaces that as `error.code === 'PT409'`. The authoritative comparison lives
 * in the database writer — these helpers only classify the outcome and provide
 * the required user guidance.
 *
 * Conflict handling NEVER retries or overwrites: on a conflict the editor keeps
 * the unsaved values visible for review and asks the advisor to refresh and
 * review the latest information before saving again. No client check is an
 * authorization or integrity control.
 */

/** The PostgREST/SQLSTATE code surfaced for a stale expected version. */
export const STALE_VERSION_CODE = "PT409";

/**
 * Required refresh-and-review guidance (R4). It deliberately does not
 * auto-retry or merge; the advisor must refresh and review the latest data.
 */
export const STALE_VERSION_GUIDANCE =
  "This record was changed by another session. Refresh and review the latest information before saving.";

/** Narrow the unknown supabase-js error shape to its string `code`. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True when a writer rejected the mutation because the row version was stale. */
export function isVersionConflict(error: unknown): boolean {
  return errorCode(error) === STALE_VERSION_CODE;
}
