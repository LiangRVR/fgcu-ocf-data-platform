-- ============================================================================
-- OCF Fellowship Management System — Active Advisor RLS
--
-- Replaces the bootstrap anon policies with authenticated advisor access.
-- Active advisors retain shared staff CRUD. Unauthenticated visitors lose all
-- access to operational tables.
-- ============================================================================

REVOKE USAGE ON SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM anon;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

DROP POLICY IF EXISTS "anon_read_advisor" ON public.advisor;
DROP POLICY IF EXISTS "anon_insert_advisor" ON public.advisor;
DROP POLICY IF EXISTS "anon_update_advisor" ON public.advisor;
DROP POLICY IF EXISTS "anon_delete_advisor" ON public.advisor;

DROP POLICY IF EXISTS "anon_read_fellowship" ON public.fellowship;
DROP POLICY IF EXISTS "anon_insert_fellowship" ON public.fellowship;
DROP POLICY IF EXISTS "anon_update_fellowship" ON public.fellowship;
DROP POLICY IF EXISTS "anon_delete_fellowship" ON public.fellowship;

DROP POLICY IF EXISTS "anon_read_student" ON public.student;
DROP POLICY IF EXISTS "anon_insert_student" ON public.student;
DROP POLICY IF EXISTS "anon_update_student" ON public.student;
DROP POLICY IF EXISTS "anon_delete_student" ON public.student;

DROP POLICY IF EXISTS "anon_read_application" ON public.application;
DROP POLICY IF EXISTS "anon_insert_application" ON public.application;
DROP POLICY IF EXISTS "anon_update_application" ON public.application;
DROP POLICY IF EXISTS "anon_delete_application" ON public.application;

DROP POLICY IF EXISTS "anon_read_advising_meeting" ON public.advising_meeting;
DROP POLICY IF EXISTS "anon_insert_advising_meeting" ON public.advising_meeting;
DROP POLICY IF EXISTS "anon_update_advising_meeting" ON public.advising_meeting;
DROP POLICY IF EXISTS "anon_delete_advising_meeting" ON public.advising_meeting;

DROP POLICY IF EXISTS "anon_read_fellowship_thursday" ON public.fellowship_thursday;
DROP POLICY IF EXISTS "anon_insert_fellowship_thursday" ON public.fellowship_thursday;
DROP POLICY IF EXISTS "anon_update_fellowship_thursday" ON public.fellowship_thursday;
DROP POLICY IF EXISTS "anon_delete_fellowship_thursday" ON public.fellowship_thursday;

DROP POLICY IF EXISTS "anon_read_scholarship_history" ON public.scholarship_history;
DROP POLICY IF EXISTS "anon_insert_scholarship_history" ON public.scholarship_history;
DROP POLICY IF EXISTS "anon_update_scholarship_history" ON public.scholarship_history;
DROP POLICY IF EXISTS "anon_delete_scholarship_history" ON public.scholarship_history;

CREATE POLICY "advisor_select_self_or_active_staff"
    ON public.advisor
    FOR SELECT TO authenticated
    USING (
        public.is_active_advisor()
        OR lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );

CREATE POLICY "advisor_insert_active_staff"
    ON public.advisor
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "advisor_update_self_link_or_active_staff"
    ON public.advisor
    FOR UPDATE TO authenticated
    USING (
        public.is_active_advisor()
        OR (
            auth_user_id IS NULL
            AND lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
    WITH CHECK (
        public.is_active_advisor()
        OR (
            auth_user_id = auth.uid()
            AND lower(coalesce(email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    );

CREATE POLICY "advisor_delete_active_staff"
    ON public.advisor
    FOR DELETE TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_fellowship"
    ON public.fellowship
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_student"
    ON public.student
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_application"
    ON public.application
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_advising_meeting"
    ON public.advising_meeting
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_fellowship_thursday"
    ON public.fellowship_thursday
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_manage_scholarship_history"
    ON public.scholarship_history
    FOR ALL TO authenticated
    USING (public.is_active_advisor())
    WITH CHECK (public.is_active_advisor());
