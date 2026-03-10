-- ============================================================================
-- OCF Fellowship Management System — Allow Anonymous Write Access
--
-- This migration grants INSERT, UPDATE, and DELETE to the Supabase anon role
-- on all application tables and adds the corresponding permissive RLS policies.
--
-- This is intentional for the development phase: the app uses Supabase's anon
-- key and does not yet implement per-user authentication.  All staff share the
-- same key and need full CRUD access.
--
-- For production, replace these open policies with user-scoped policies.
-- ============================================================================


-- ============================================================================
-- Extend table-level privileges to cover write operations
-- ============================================================================
GRANT INSERT, UPDATE, DELETE ON public.advisor             TO anon;
GRANT INSERT, UPDATE, DELETE ON public.fellowship          TO anon;
GRANT INSERT, UPDATE, DELETE ON public.student             TO anon;
GRANT INSERT, UPDATE, DELETE ON public.application         TO anon;
GRANT INSERT, UPDATE, DELETE ON public.advising_meeting    TO anon;
GRANT INSERT, UPDATE, DELETE ON public.fellowship_thursday TO anon;
GRANT INSERT, UPDATE, DELETE ON public.scholarship_history TO anon;

-- Sequences need access so that serial/generated PKs can be advanced
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;


-- ============================================================================
-- advisor — write access
-- ============================================================================
CREATE POLICY "anon_insert_advisor"
    ON public.advisor FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_advisor"
    ON public.advisor FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_advisor"
    ON public.advisor FOR DELETE TO anon USING (true);


-- ============================================================================
-- fellowship — write access
-- ============================================================================
CREATE POLICY "anon_insert_fellowship"
    ON public.fellowship FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_fellowship"
    ON public.fellowship FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_fellowship"
    ON public.fellowship FOR DELETE TO anon USING (true);


-- ============================================================================
-- student — write access
-- ============================================================================
CREATE POLICY "anon_insert_student"
    ON public.student FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_student"
    ON public.student FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_student"
    ON public.student FOR DELETE TO anon USING (true);


-- ============================================================================
-- application — write access
-- ============================================================================
CREATE POLICY "anon_insert_application"
    ON public.application FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_application"
    ON public.application FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_application"
    ON public.application FOR DELETE TO anon USING (true);


-- ============================================================================
-- advising_meeting — write access
-- ============================================================================
CREATE POLICY "anon_insert_advising_meeting"
    ON public.advising_meeting FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_advising_meeting"
    ON public.advising_meeting FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_advising_meeting"
    ON public.advising_meeting FOR DELETE TO anon USING (true);


-- ============================================================================
-- fellowship_thursday — write access
-- ============================================================================
CREATE POLICY "anon_insert_fellowship_thursday"
    ON public.fellowship_thursday FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_fellowship_thursday"
    ON public.fellowship_thursday FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_fellowship_thursday"
    ON public.fellowship_thursday FOR DELETE TO anon USING (true);


-- ============================================================================
-- scholarship_history — write access
-- ============================================================================
CREATE POLICY "anon_insert_scholarship_history"
    ON public.scholarship_history FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon_update_scholarship_history"
    ON public.scholarship_history FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_scholarship_history"
    ON public.scholarship_history FOR DELETE TO anon USING (true);
