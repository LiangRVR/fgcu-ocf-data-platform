-- ============================================================================
-- OCF Fellowship Management System — Atomic Advisor Role Change
--
-- Forward-only, additive migration. FUNDAMENTAL FINAL P1 remediation for
-- AI-DLC change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Finding — lease fencing cannot cover arbitrarily delayed EXTERNAL GoTrue
--   Auth Admin API writes: the trusted adapter updated the Auth claim via
--   GoTrue (a separate HTTP service) and the protected display role via a
--   fenced Postgres write, serialized only by a lease. A lease can expire (or
--   the external call can be delayed) between the two writes, leaving a
--   claim/display mismatch that no in-process fence can rule out.
--
--   Remediation — replace the trusted role-change implementation with a NARROW
--   service-role-only SECURITY DEFINER database RPC that updates the target
--   bound advisor's `auth.users.raw_app_meta_data.ocf_admin` JSON boolean AND
--   its protected `public.advisor.role` display projection in ONE Postgres
--   transaction:
--
--     - `set_advisor_role(advisor_id, role)` validates the role (exactly
--       Admin/Advisor), locks the advisor row, verifies it exists and is
--       BOUND (`auth_user_id` non-NULL with a live `auth.users` row), then
--       atomically:
--         1. sets `auth.users.raw_app_meta_data.ocf_admin` to the matching
--            JSON boolean (`jsonb_set`, preserving the rest of app_metadata —
--            the same value GoTrue would write, so the next JWT refresh
--            reflects it); and
--         2. sets `public.advisor.role` to the display projection.
--       The single transaction makes a claim/display mismatch IMPOSSIBLE: the
--       transaction commits with both consistent or aborts with neither
--       changed.
--     - SECURITY DEFINER (postgres-owned), empty search_path, fully qualified
--       relations, EXECUTE revoked from PUBLIC/anon/authenticated and pinned to
--       service_role ONLY — browser clients can never invoke it, and active
--       authorization remains claim-based (the display is a projection).
--     - Never touches `auth_user_id` (no rebind), `is_active`, or history;
--       preserves one-time binding, immutable advising history, and every FK.
--
--   The prior per-advisor lease / fenced-write / fenced-read / reconcile RPCs
--   and the `advisor_role_lock` table REMAIN but are NOT relied on by the
--   normal role-change flow (they are harmless legacy primitives; the adapter
--   now calls `set_advisor_role` for every role change). No existing migration,
--   table, column, row, FK, RLS policy, or function is edited, deleted, or
--   reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Atomic role change: claim + protected display projection in one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_advisor_role(
    p_advisor_id integer,
    p_role text
)
RETURNS TABLE (advisor_id integer, role text, auth_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid;
    v_updated integer;
BEGIN
    -- Strict role validation: exactly Admin/Advisor (the CHECK constraint
    -- would also reject a bad value, but fail closed before any work).
    IF p_role IS NULL OR p_role NOT IN ('Admin', 'Advisor') THEN
        RAISE EXCEPTION 'set_advisor_role role must be Admin or Advisor'
            USING ERRCODE = '22023';
    END IF;

    -- Target must exist and be the object of the change. The row lock
    -- serializes concurrent set_advisor_role calls for the same advisor, so
    -- the last writer wins with claim + display always set together.
    SELECT a.auth_user_id
      INTO v_auth_user_id
      FROM public.advisor a
     WHERE a.advisor_id = p_advisor_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'advisor % does not exist', p_advisor_id
            USING ERRCODE = 'P0002';
    END IF;

    -- No rebinding: a role change requires an already-bound advisor identity.
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'advisor % is not bound to an Auth identity, so its role cannot be changed', p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    -- 1. Atomically set the trusted Auth claim (JSON boolean; jsonb_set
    --    preserves the rest of app_metadata, matching GoTrue's merge).
    UPDATE auth.users AS u
       SET raw_app_meta_data = jsonb_set(
           coalesce(u.raw_app_meta_data, '{}'::jsonb),
           '{ocf_admin}',
           to_jsonb(p_role = 'Admin')
       )
     WHERE u.id = v_auth_user_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
        -- Orphaned binding (the auth identity no longer exists): fail closed —
        -- NOTHING changed (the transaction aborts).
        RAISE EXCEPTION 'advisor % is not bound to an existing Auth identity', p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. Set the protected display projection (same transaction). The table
    --    alias qualifies the column (the RETURNS TABLE out-param `advisor_id`
    --    is also in scope).
    UPDATE public.advisor AS a
       SET role = p_role
     WHERE a.advisor_id = p_advisor_id;

    RETURN QUERY
    SELECT p_advisor_id, p_role, v_auth_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_advisor_role(integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_advisor_role(integer, text)
    TO service_role;

COMMENT ON FUNCTION public.set_advisor_role(integer, text) IS
    'ATOMIC trusted role change (service-role only): validates the role (Admin/Advisor), locks the target advisor row, verifies it exists and is bound, then in ONE transaction sets auth.users.raw_app_meta_data.ocf_admin to the matching JSON boolean AND public.advisor.role to the display projection. A claim/display mismatch is impossible (commit = both consistent; abort = neither changed). Never rebinds, never touches is_active/history, and is the only normal writer of the display role for the role-change flow. EXECUTE pinned to service_role only — clients cannot call it.';