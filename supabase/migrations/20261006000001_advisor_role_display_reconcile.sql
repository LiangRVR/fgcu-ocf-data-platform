-- ============================================================================
-- OCF Fellowship Management System — Durable Display-Role Reconciliation
--
-- Forward-only, additive migration. Latest P1 review remediation for AI-DLC
-- change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Finding — after the Auth claim mutation, a DEFINITIVE fenced-write `false`
--   that is due solely to lease expiry (WITHOUT a takeover) can leave
--   `claim = desired` while `display = old` — a persistent claim/display
--   mismatch, because no competing holder will ever converge it and the
--   operation returned `lock_lost` without touching anything.
--
--   Remediation — a DURABLE safe convergence path (not a best-effort
--   in-process assumption): the protected display role is a PROJECTION of the
--   authoritative Auth claim, so a lease-fenced database reconciliation can
--   always re-align `advisor.role` to `auth.users.raw_app_meta_data.ocf_admin`.
--
--     - `reconcile_advisor_role_display(advisor_id, holder)` is SECURITY
--       DEFINER and runs in ONE transaction: it locks the per-advisor lease
--       row (`FOR UPDATE`, serialized with acquire/takeover/release), verifies
--       the caller's holder still owns a NON-EXPIRED lease, reads the
--       AUTHORITATIVE claim from `auth.users`, and updates `advisor.role` to
--       the claim's projection (`Admin` when the JSON boolean `ocf_admin` is
--       true, otherwise `Advisor`) if it does not already match. Returns the
--       resulting display role; NULL when the holder no longer owns a
--       non-expired lease (must not touch anything).
--
--   Convergence paths built on this RPC:
--     * EXPIRY WITHOUT TAKEOVER: the operation whose fenced write was fenced
--       out re-acquires the expired lease, reconciles display to the (still
--       its own) claim, and returns a safe reconciled SUCCESS — no persistent
--       mismatch, even if no competing holder ever appears.
--     * EXPIRY WITH TAKEOVER + CRASHED COMPETITOR: the losing operation cannot
--       re-acquire (an active holder owns the lease) and returns `lock_lost`;
--       the durable recovery — the start-of-operation reconciliation of the
--       NEXT trusted role change, or the explicit trusted
--       `recoverAdvisorRoleChange` adapter path — re-aligns display to the
--       claim, so the state is EVENTUALLY consistent even if the competing
--       holder crashed.
--     * ACTIVE AUTHORIZATION REMAINS CLAIM-BASED: the reconcile RPC never
--       consults `advisor.role` for authorization and never touches
--       `auth_user_id`, `is_active`, or GoTrue's stored claim — it only makes
--       the DISPLAY follow the claim. No client bypass is introduced (the RPC
--       is service_role-pinned SECURITY DEFINER behind the same lease fence).
--
-- No existing migration, table, column, row, FK, RLS policy, or function is
-- edited, deleted, or reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Lease-fenced display-role reconciliation.
--
-- SECURITY DEFINER (postgres-owned, empty search_path, fully qualified
-- relations). The per-advisor lease row is locked FOR UPDATE first, so this
-- serializes with a concurrent acquire/takeover/release; the ownership check
-- and the display alignment are atomic with respect to the lock lifecycle.
-- The display role is derived ONLY from the authoritative Auth claim
-- (`auth.users.raw_app_meta_data.ocf_admin` JSON boolean — the same strict
-- rule as `public.is_ocf_admin()`), never from any client input.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_advisor_role_display(
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
    v_claim boolean;
    v_role text;
    v_desired text;
BEGIN
    -- Fence: lock the per-advisor lease row and verify THIS holder still owns
    -- a NON-EXPIRED lease. `FOR UPDATE` serializes this transaction with any
    -- concurrent acquire/takeover/release.
    SELECT true INTO v_owned
      FROM public.advisor_role_lock
     WHERE advisor_id = p_advisor_id
       AND holder = p_holder
       AND lease_expires_at > now()
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL; -- holder no longer owns a non-expired lease: touch nothing
    END IF;

    -- The AUTHORITATIVE Auth claim projects the display role. An unbound /
    -- orphaned advisor (no matching auth user) or a missing/non-boolean claim
    -- resolves to the safe `Advisor` projection (identical to is_ocf_admin()).
    SELECT (u.raw_app_meta_data -> 'ocf_admin') = 'true'::jsonb
      INTO v_claim
      FROM public.advisor a
      JOIN auth.users u ON u.id = a.auth_user_id
     WHERE a.advisor_id = p_advisor_id;

    v_desired := CASE WHEN coalesce(v_claim, false) THEN 'Admin' ELSE 'Advisor' END;

    SELECT a.role
      INTO v_role
      FROM public.advisor a
     WHERE a.advisor_id = p_advisor_id;

    IF v_role IS DISTINCT FROM v_desired THEN
        UPDATE public.advisor
           SET role = v_desired
         WHERE advisor_id = p_advisor_id;
    END IF;

    RETURN v_desired;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_advisor_role_display(integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_advisor_role_display(integer, text)
    TO service_role;

COMMENT ON FUNCTION public.reconcile_advisor_role_display(integer, text) IS
    'Durable display-role reconciliation: under a lease-row lock, aligns public.advisor.role to the authoritative Auth claim projection (auth.users.raw_app_meta_data.ocf_admin JSON boolean) for the advisor bound to the caller''s non-expired holder lease; returns the resulting role, or NULL when the holder lost the lease. Never consults advisor.role for authorization, never touches auth_user_id/is_active/the claim; makes the DISPLAY follow the CLAIM so any expiry/crash mismatch durably converges.';

-- ---------------------------------------------------------------------------
-- The acquire / fenced-write / fenced-read / verify RPCs from migrations
-- 20261003000001-20261005000001 are unchanged; the reconciliation above is the
-- durable convergence path for a fenced-out write after Auth claim mutation.
-- ---------------------------------------------------------------------------