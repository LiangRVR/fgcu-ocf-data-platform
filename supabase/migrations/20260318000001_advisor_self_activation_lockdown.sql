-- ============================================================================
-- OCF Fellowship Management System — Advisor Self-Activation Lockdown
--
-- Remediates a confirmed RLS privilege-escalation path in
-- 20260317000004_active_advisor_rls.sql. Under the old
-- `advisor_update_self_link_or_active_staff` policy, an email-matched,
-- unlinked advisor could UPDATE their own row and, in a single statement,
-- bind `auth_user_id`, set `is_active = true`, and elevate `role` — granting
-- staff access to student PII. This migration:
--
--   1. drops that vulnerable general UPDATE policy;
--   2. replaces the advisor SELECT email-match self-read with the
--      `auth_user_id = auth.uid()` self-read (amendment A1): an advisor row is
--      readable only by its own pre-bound user (`auth_user_id = auth.uid()`) or
--      by active staff (`public.is_active_advisor()`); an unbound,
--      email-matched account — active or inactive — receives zero advisor rows
--      and no PII. Pre-bound inactive self-read and active-staff full advisor
--      read access are preserved;
--   3. adds an active-staff-only advisor UPDATE policy (no self-link path
--      through the table API for non-active advisors);
--   4. adds an invoker-security one-time-bind `BEFORE INSERT OR UPDATE OF
--      auth_user_id` trigger: ordinary active staff may INSERT unbound advisor
--      rows (`auth_user_id` NULL), but `auth_user_id` may only be set non-NULL
--      — at INSERT (bound-row creation) or via the NULL→non-NULL UPDATE bind —
--      by a trusted `service_role`/DBA session (`current_user = 'service_role'`,
--      legacy `auth.role() = 'service_role'`, or `session_user = 'postgres'`).
--      Every replace/rebind, clear, and authenticated write is rejected
--      fail-closed, so the column is immutable after the initial trusted bind;
--   5. supersedes the earlier email self-link RPC design
--      (`link_current_advisor`): the function is removed if present and is
--      NOT recreated. There is no self-link RPC of any kind. Identity binding
--      is admin-only: an administrator pre-binds `advisor.auth_user_id` to
--      the invited auth account's user id before first sign-in (via the
--      server-only provisioning module), and unlinked advisors may never
--      self-link by email;
--   6. adds a forward-only case-insensitive unique index on `lower(email)`
--      so advisor email identity is case-unique (R11).
--
-- Forward-only, idempotent on re-apply, no tables/columns/data touched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove the vulnerable unlinked self-link general UPDATE policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_update_self_link_or_active_staff"
    ON public.advisor;

-- ---------------------------------------------------------------------------
-- 2. Replace the advisor SELECT email-match self-read (amendment A1).
--
-- The previous `advisor_select_self_or_active_staff` policy let an account
-- read any `advisor` row whose email matched its JWT email — the email-match
-- branch `lower(email) = lower(auth.jwt() ->> 'email')`. That branch exposed
-- advisor PII to an UNBOUND, email-matched account (a user never pre-bound to
-- the row) and kept the row resolvable by email. Per amendment A1 the SELECT
-- policy now grants exactly two read paths:
--
--   - `auth_user_id = auth.uid()` — a PRE-BOUND advisor reads ONLY their own
--     row. This preserves the pre-bound INACTIVE self-read and is also the
--     self-read half of the pre-bound active advisor's access;
--   - `public.is_active_advisor()` — ACTIVE STAFF (a pre-bound advisor with
--     `is_active = true`) retain the existing full advisor read access.
--
-- An unbound, email-matched account — active or inactive — satisfies neither
-- branch (`auth_user_id` is NULL, so `auth_user_id = auth.uid()` can never
-- hold, and `is_active_advisor()` requires a pre-bound active row) and
-- therefore receives ZERO advisor rows and no PII.
--
-- Forward-only: this drops and recreates the one SELECT policy only; no
-- tables, columns, or data are touched. Idempotent on re-apply.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_select_self_or_active_staff"
    ON public.advisor;

CREATE POLICY "advisor_select_self_or_active_staff"
    ON public.advisor
    FOR SELECT TO authenticated
    USING (
        public.is_active_advisor()
        OR auth_user_id = auth.uid()
    );

-- ---------------------------------------------------------------------------
-- 3. Active-staff-only advisor UPDATE.
--
-- A non-active advisor now has NO UPDATE path on public.advisor through the
-- API. There is no self-link RPC either: `auth_user_id` is bound only by an
-- administrator before first sign-in. The row never self-binds and cannot
-- escalate `is_active`/`role`/`email`.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_update_active_staff_only"
    ON public.advisor;

CREATE POLICY "advisor_update_active_staff_only"
    ON public.advisor
    FOR UPDATE TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

-- ---------------------------------------------------------------------------
-- 4. Invoker-security one-time-bind guard on advisor.auth_user_id.
--
-- Identity binding is ADMIN-ONLY: `auth_user_id` may only be non-NULL as the
-- invited account's uuid, written by a trusted `service_role`/DBA session (the
-- server-only provisioning path). The guard enforces that on BOTH INSERT and
-- UPDATE:
--
--   - INSERT with `auth_user_id` NULL (an UNBOUND row) is the ordinary
--     active-staff advisor-creation path and is allowed for any session that
--     satisfies the RLS insert policy (`advisor_insert_active_staff`);
--   - INSERT with a non-NULL `auth_user_id` (a BOUND row, created by the
--     provisioning path) is trusted-only;
--   - UPDATE NULL -> non-NULL (the one-time bind) is trusted-only;
--   - UPDATE replace/rebind (non-NULL -> different non-NULL) and clear
--     (non-NULL -> NULL) are rejected outright for EVERY session, trusted or
--     not — the column is immutable after its initial bind;
--   - no authenticated actor may ever create or write a non-NULL
--     `auth_user_id`.
--
-- This is a `BEFORE INSERT OR UPDATE OF auth_user_id` trigger: it fires on
-- every INSERT of an advisor row and only on UPDATE statements that actually
-- target `auth_user_id`, so ordinary staff edits to other advisor columns
-- never trip the guard.
--
-- The function is SECURITY INVOKER (never SECURITY DEFINER): `current_user`,
-- `session_user`, and `auth.role()` therefore reflect the real invoking
-- session, so the trust check cannot be bypassed by definer privilege.
-- Trusted binders are recognized by:
--   - `current_user = 'service_role'`      (PostgREST service-role session),
--   - legacy `auth.role() = 'service_role'` (JWT-claim fallback), or
--   - `session_user = 'postgres'`          (migration / DBA psql runs).
-- Every other non-NULL transition raises a fail-closed exception. An unbound
-- INSERT (`NEW.auth_user_id IS NULL`) and a no-op update that leaves the value
-- unchanged (`NEW.auth_user_id IS NOT DISTINCT FROM OLD.auth_user_id`) pass
-- through, so ordinary staff row creation and column edits are unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_advisor_auth_user_id_one_time_bind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- INSERT path: creating an UNBOUND advisor row (auth_user_id NULL) is the
    -- ordinary active-staff flow and is allowed for any session that satisfies
    -- the RLS insert policy. Creating a BOUND row (non-NULL auth_user_id) is a
    -- provisioning action and is trusted-only.
    IF TG_OP = 'INSERT' THEN
        IF NEW.auth_user_id IS NULL THEN
            RETURN NEW;
        END IF;

        IF current_user = 'service_role'
           OR auth.role() = 'service_role'
           OR session_user = 'postgres'
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'advisor.auth_user_id is one-time bind only: creating a bound advisor row requires a trusted service_role/DBA session';
    END IF;

    -- UPDATE path, no-op: the value did not change (both NULL, or the identical
    -- uuid). Pass through unchanged so ordinary updates that include the current
    -- binding are never blocked.
    IF NEW.auth_user_id IS NOT DISTINCT FROM OLD.auth_user_id THEN
        RETURN NEW;
    END IF;

    -- The only legitimate UPDATE transition is the one-time NULL -> non-NULL
    -- bind performed by a trusted service_role / DBA session.
    IF OLD.auth_user_id IS NULL AND NEW.auth_user_id IS NOT NULL THEN
        IF current_user = 'service_role'
           OR auth.role() = 'service_role'
           OR session_user = 'postgres'
        THEN
            RETURN NEW;
        END IF;
    END IF;

    -- Fail closed: any other write to auth_user_id — an authenticated bind, a
    -- trusted-path replace/rebind, or a clear — is rejected outright.
    RAISE EXCEPTION
        'advisor.auth_user_id is one-time bind only: it may be set once from NULL by a trusted service_role/DBA session and never replaced, re-bound, or cleared';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advisor_auth_user_id_one_time_bind()
    FROM PUBLIC, anon, authenticated;

-- The trigger mechanism invokes this function without any EXECUTE grant, so
-- nobody needs (or is given) call access. The explicit service_role entry pins
-- the ACL non-empty: a function whose ACL reverts to the default grants
-- EXECUTE to PUBLIC, so an entry must remain. Direct invocation is harmless —
-- the function only works as a row trigger (NEW/OLD are not assigned in a
-- plain call).
GRANT EXECUTE ON FUNCTION public.guard_advisor_auth_user_id_one_time_bind()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advisor_auth_user_id_one_time_bind
    ON public.advisor;

CREATE TRIGGER trg_advisor_auth_user_id_one_time_bind
    BEFORE INSERT OR UPDATE OF auth_user_id ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advisor_auth_user_id_one_time_bind();

COMMENT ON FUNCTION public.guard_advisor_auth_user_id_one_time_bind() IS
    'Invoker-security guard: advisor.auth_user_id may be NULL at INSERT for any active-staff row, but a non-NULL value may only be created (INSERT) or set (UPDATE NULL->non-NULL) by a trusted service_role/DBA session; all replaces, clears, and authenticated writes are rejected.';

-- ---------------------------------------------------------------------------
-- 5. Supersede the email self-link RPC design.
--
-- An earlier iteration of this migration created the authenticated, no-argument
-- SECURITY DEFINER RPC `link_current_advisor()`. Per the approved design that
-- email-only self-link is removed: identity binding is admin-only (pre-bound
-- `auth_user_id`), and the session resolves the advisor by `auth_user_id`
-- only. This guard removes the function if a prior version ever created it and
-- the migration creates NO replacement — the final schema has no self-link RPC.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.link_current_advisor();

-- ---------------------------------------------------------------------------
-- 6. Case-insensitive advisor-email uniqueness (R11).
--
-- The existing `advisor_email_key` unique index on `email` is case-sensitive,
-- so two rows whose emails differ only by case could both exist and both
-- resolve as distinct identities. This forward-only expression index on
-- `lower(email)` makes advisor email identity case-insensitive: a case-variant
-- duplicate insert is rejected (unique_violation 23505) and an email resolves
-- to at most one advisor row. NULL emails stay allowed (NULL keys are never
-- equal in a unique index). Idempotent-safe on re-apply via IF NOT EXISTS; no
-- data is touched.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS advisor_email_lower_key
    ON public.advisor (lower(email));