-- ============================================================================
-- OCF Fellowship Management System — Core History DELETE Lockdown
--
-- Forward-only, additive migration. Independent review-blocker remediation:
-- authenticated browser sessions could still destructively DELETE core
-- historical entities (`advisor`, `student`, `fellowship`, `application`)
-- through the broad `GRANT ... DELETE ... TO authenticated` (migration
-- ...004) combined with the FOR ALL active-advisor RLS policies and the
-- `advisor_delete_active_staff` policy. Since migration 20260930000005,
-- destructive removal of these entities is a secure archive/deactivate
-- lifecycle (`public.lifecycle_transition`), so direct DELETE is now revoked
-- and denied at the database boundary:
--
--   1. REVOKE DELETE on advisor, student, fellowship, and application from
--      `authenticated` at the table-privilege level. The other authenticated
--      privileges (SELECT/INSERT/UPDATE) are unchanged, and the
--      service_role / DBA grants (Supabase default privileges) are untouched,
--      so local synthetic-fixture seeding/cleanup and the service-role FK
--      contract tests keep working;
--   2. drop the FOR ALL active-advisor policies on student, fellowship, and
--      application and recreate them as explicit SELECT / INSERT / UPDATE
--      policies only — the same append-only policy style used for
--      `advising_meeting` — so no DELETE policy exists for `authenticated` at
--      the RLS level either;
--   3. drop `advisor_delete_active_staff`; the advisor SELECT / INSERT /
--      UPDATE policies are unchanged;
--   4. leaves append-only `advising_meeting` / `advising_meeting_amendment`
--      and the still-mutable operational rows `fellowship_thursday` /
--      `scholarship_history` untouched (authenticated DELETE stays available
--      there).
--
-- Forward-only, idempotent on re-apply: no tables, columns, rows, FKs, or
-- prior migrations are edited, deleted, or reset.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke the DELETE table privilege from authenticated for the four core
-- historical entities. service_role / DBA grants are never touched, so the
-- trusted fixture and contract-test cleanup paths keep working.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON TABLE public.advisor FROM authenticated;
REVOKE DELETE ON TABLE public.student FROM authenticated;
REVOKE DELETE ON TABLE public.fellowship FROM authenticated;
REVOKE DELETE ON TABLE public.application FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. student / fellowship / application: replace the FOR ALL active-advisor
-- policy with explicit SELECT / INSERT / UPDATE policies (no DELETE policy).
-- The lifecycle fields (`archived_at`) remain additionally guarded by the
-- column-scoped invoker-security triggers from migration 20260930000005.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "active_advisor_manage_student" ON public.student;

CREATE POLICY "active_advisor_select_student"
    ON public.student
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_student"
    ON public.student
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_update_student"
    ON public.student
    FOR UPDATE TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

DROP POLICY IF EXISTS "active_advisor_manage_fellowship" ON public.fellowship;

CREATE POLICY "active_advisor_select_fellowship"
    ON public.fellowship
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_fellowship"
    ON public.fellowship
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_update_fellowship"
    ON public.fellowship
    FOR UPDATE TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

DROP POLICY IF EXISTS "active_advisor_manage_application" ON public.application;

CREATE POLICY "active_advisor_select_application"
    ON public.application
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_application"
    ON public.application
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_update_application"
    ON public.application
    FOR UPDATE TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

-- ---------------------------------------------------------------------------
-- 3. advisor: drop the active-staff DELETE policy. The SELECT
-- (`advisor_select_self_or_active_staff`), INSERT
-- (`advisor_insert_active_staff`), and UPDATE
-- (`advisor_update_active_staff_only`) policies are unchanged.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_delete_active_staff" ON public.advisor;