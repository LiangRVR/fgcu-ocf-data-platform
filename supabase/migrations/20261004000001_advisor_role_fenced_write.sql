-- ============================================================================
-- OCF Fellowship Management System — Fenced Advisor Role-Write + Ownership Check
--
-- Forward-only, additive migration. Final P1 review remediation for AI-DLC
-- change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Finding — a fixed lease can expire MID-operation: after the trusted
--   adapter updates the Auth `app_metadata` claim (GoTrue) but before it
--   writes the protected `advisor.role` display projection, the lease can
--   expire and another holder can take the lock and complete an OPPOSING role
--   change. The stale holder then writes its display role (or performs an
--   unsafe compensation rollback) on top of the new holder's state, leaving
--   the Auth claim and display role INCONSISTENT.
--
--   Remediation — database fencing/ownership verification for the protected
--   display-role write:
--
--     - `fenced_write_advisor_role_display(advisor_id, holder, role)` is the
--       ONLY writer of `advisor.role` for the role-change flow. It runs in ONE
--       transaction: it takes a row lock on the per-advisor lease
--       (`advisor_role_lock ... FOR UPDATE`), verifies the caller's holder
--       still owns a NON-EXPIRED lease, and only then updates the display
--       role. The row lock serializes with a concurrent acquire/takeover/
--       release, so a stale holder whose lease has expired — or who was
--       superseded by a takeover — can NEVER land the display-role write.
--       Returns true when the write landed; false when the holder no longer
--       owns a non-expired lease (write fenced out). Bounded stale recovery is
--       unchanged (expired leases are taken over by acquire).
--
--     - `verify_advisor_role_lock(advisor_id, holder)` returns whether the
--       holder STILL owns a non-expired lease. The adapter uses it to make
--       COMPENSATION holder-aware: the Auth-claim rollback only runs while the
--       caller still owns the lease, so a stale holder can never roll back a
--       NEW holder's claim.
--
--   Fenced failures return a SAFE result path (`lock_lost`): the operation
--   that lost the lease reports a conflict and performs NO further mutation,
--   so the new holder's claim/display state is preserved.
--
-- No existing migration, table, column, row, FK, RLS policy, or function is
-- edited, deleted, or reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fenced protected-display-role write.
--
--    SECURITY DEFINER (postgres-owned, empty search_path, fully qualified
--    relations). The lease row is locked FOR UPDATE first, so this serializes
--    with a concurrent `acquire_advisor_role_lock` (takeover) or
--    `release_advisor_role_lock`: the holder/expiry check and the display-role
--    write are atomic with respect to the lock lifecycle. If the lease row is
--    absent, held by a DIFFERENT holder, or EXPIRED, the write is fenced out
--    (returns false) and the advisor row is left untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fenced_write_advisor_role_display(
    p_advisor_id integer,
    p_holder text,
    p_role text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owned boolean;
BEGIN
    -- Fail closed on a malformed write request (the display vocabulary is
    -- exactly Admin/Advisor and the holder is the lease token).
    IF p_role IS NULL OR p_role NOT IN ('Admin', 'Advisor') THEN
        RAISE EXCEPTION 'fenced_write_advisor_role_display role must be Admin or Advisor'
            USING ERRCODE = '22023';
    END IF;
    IF p_holder IS NULL OR p_holder = '' THEN
        RAISE EXCEPTION 'fenced_write_advisor_role_display requires a non-empty holder'
            USING ERRCODE = '22023';
    END IF;

    -- Fence: lock the per-advisor lease row and verify THIS holder still owns
    -- a NON-EXPIRED lease. `FOR UPDATE` serializes this transaction with any
    -- concurrent acquire/takeover/release, so the ownership check cannot be
    -- raced by another holder taking the lock between the check and the write.
    SELECT true INTO v_owned
      FROM public.advisor_role_lock
     WHERE advisor_id = p_advisor_id
       AND holder = p_holder
       AND lease_expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN
        -- The holder no longer owns a non-expired lease (expired, superseded
        -- by a takeover, or released): the display-role write is FENCED OUT.
        RETURN false;
    END IF;

    -- Only the verified holder may write the protected display role.
    UPDATE public.advisor
       SET role = p_role
     WHERE advisor_id = p_advisor_id;

    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fenced_write_advisor_role_display(integer, text, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fenced_write_advisor_role_display(integer, text, text)
    TO service_role;

COMMENT ON FUNCTION public.fenced_write_advisor_role_display(integer, text, text) IS
    'Fenced protected-display-role write: the ONLY writer of advisor.role for the role-change flow. Atomically verifies (with a lease-row lock) that the caller''s holder owns a NON-EXPIRED per-advisor lease, then writes the role; returns false (write fenced out, advisor untouched) when the holder lost the lease (expired/superseded/released). Prevents a stale mid-operation holder from writing after another holder takes the lock.';

-- ---------------------------------------------------------------------------
-- 2. Holder-aware ownership check (for safe compensation decisions).
--
--    Returns whether the holder STILL owns a non-expired lease. The adapter
--    uses this to gate the Auth-claim compensation rollback: compensation only
--    runs while the caller still owns the lease, so a stale holder can never
--    roll back a NEW holder's claim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_advisor_role_lock(
    p_advisor_id integer,
    p_holder text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.advisor_role_lock
         WHERE advisor_id = p_advisor_id
           AND holder = p_holder
           AND lease_expires_at > now()
    );
$$;

REVOKE ALL ON FUNCTION public.verify_advisor_role_lock(integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_advisor_role_lock(integer, text)
    TO service_role;

COMMENT ON FUNCTION public.verify_advisor_role_lock(integer, text) IS
    'Holder-aware ownership check: true only when the holder still owns a NON-EXPIRED per-advisor lease. Used to gate compensation so a stale holder never rolls back a new holder''s Auth claim.';