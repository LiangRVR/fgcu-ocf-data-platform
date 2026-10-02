-- ============================================================================
-- OCF Fellowship Management System — Fenced Display-Role Read-Back
--
-- Forward-only, additive migration. Final P1 review remediation for AI-DLC
-- change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Finding — an unknown/lost response from `fenced_write_advisor_role_display`
--   must NOT trigger a guessed Auth rollback. When the fenced write RPC fails
--   (the write may have committed but the response was lost), the previous
--   flow read the claim back / checked ownership and then rolled the Auth
--   claim back — but if the write HAD committed, rolling the claim back leaves
--   claim and display role INCONSISTENT (a guessed rollback).
--
--   Remediation — exact display-role READ-BACK / reconciliation while the
--   same holder owns a non-expired lease, BEFORE any compensation:
--
--     - `fenced_read_advisor_role_display(advisor_id, holder)` returns the
--       CURRENT protected display role ONLY while the caller's holder still
--       owns a NON-EXPIRED per-advisor lease (atomically verified with a
--       lease-row `FOR UPDATE`, serialized with acquire/takeover/release);
--       NULL when the holder no longer owns the lease. The trusted adapter
--       uses it to decide the outcome of an uncertain fenced write:
--         * read-back == desired display role → the write committed but the
--           response was lost → keep the matching Auth claim and return a
--           SAFE SUCCESS;
--         * read-back != desired → the write did NOT land → compensate ONLY
--           then (holder-aware rollback to the KNOWN previous claim);
--         * read-back is NULL (holder lost the lease) → do NOT compensate,
--           report `lock_lost`;
--         * the read-back call itself fails (ownership/read-back cannot be
--           verified) → do NOT compensate, return the explicit
--           `reconciliation_required` failure for trusted recovery.
--
-- No existing migration, table, column, row, FK, RLS policy, or function is
-- edited, deleted, or reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Fenced display-role read-back.
--
-- SECURITY DEFINER (postgres-owned, empty search_path, fully qualified
-- relations). The per-advisor lease row is locked FOR UPDATE first, so this
-- serializes with a concurrent `acquire_advisor_role_lock` (takeover) or
-- `release_advisor_role_lock`: the ownership check and the display-role read
-- are atomic with respect to the lock lifecycle. Returns NULL when the holder
-- no longer owns a non-expired lease (expired, superseded by a takeover, or
-- released) — the caller must not compensate on an unverifiable state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fenced_read_advisor_role_display(
    p_advisor_id integer,
    p_holder text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owned boolean;
    v_role text;
BEGIN
    -- Fence: lock the per-advisor lease row and verify THIS holder still owns
    -- a NON-EXPIRED lease. `FOR UPDATE` serializes this transaction with any
    -- concurrent acquire/takeover/release, so the ownership check and the
    -- read-back cannot be raced by another holder taking the lock between them.
    SELECT true INTO v_owned
      FROM public.advisor_role_lock
     WHERE advisor_id = p_advisor_id
       AND holder = p_holder
       AND lease_expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN
        -- The holder no longer owns a non-expired lease: no read-back is
        -- authorized (NULL = unverifiable/lost).
        RETURN NULL;
    END IF;

    -- Read the CURRENT protected display role under the held lease-row lock.
    SELECT a.role
      INTO v_role
      FROM public.advisor a
     WHERE a.advisor_id = p_advisor_id;

    RETURN v_role;
END;
$$;

REVOKE ALL ON FUNCTION public.fenced_read_advisor_role_display(integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fenced_read_advisor_role_display(integer, text)
    TO service_role;

COMMENT ON FUNCTION public.fenced_read_advisor_role_display(integer, text) IS
    'Fenced display-role read-back: returns the CURRENT protected advisor.role ONLY while the caller''s holder owns a NON-EXPIRED per-advisor lease (lease-row locked, atomic with the lock lifecycle); NULL when the holder lost the lease. Used to reconcile an uncertain fenced write WITHOUT a guessed Auth rollback: matching role = safe success (response lost); non-matching = compensate only then; NULL / unavailable = do not compensate, require trusted reconciliation.';