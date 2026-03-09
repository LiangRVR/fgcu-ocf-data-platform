-- ============================================================================
-- OCF Fellowship Management System — Allow Anonymous Read Access
--
-- This migration adds RLS SELECT policies that let the Supabase anon role
-- read all rows from every table.  This is intentional for the development
-- phase of the project: the app uses Supabase's anon key and does not yet
-- implement per-user authentication.
--
-- For production, replace these open policies with user-scoped policies
-- that restrict reads to records the signed-in user is authorised to see.
-- ============================================================================


-- ============================================================================
-- Grant schema + table access to the anon role
-- ============================================================================
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;


-- ============================================================================
-- advisor — read access
-- Advisors are reference data; any visitor may read the list.
-- ============================================================================
CREATE POLICY "anon_read_advisor"
    ON public.advisor
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- fellowship — read access
-- Fellowship names are reference data; any visitor may read the list.
-- ============================================================================
CREATE POLICY "anon_read_fellowship"
    ON public.fellowship
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- student — read access
-- OCF staff need to browse all student records; open read is acceptable
-- while the app runs under a single shared anon key.
-- ============================================================================
CREATE POLICY "anon_read_student"
    ON public.student
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- application — read access
-- Application pipeline data must be visible to OCF staff reviewing submissions.
-- ============================================================================
CREATE POLICY "anon_read_application"
    ON public.application
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- advising_meeting — read access
-- Meeting history is read by advisors to review past interactions.
-- ============================================================================
CREATE POLICY "anon_read_advising_meeting"
    ON public.advising_meeting
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- fellowship_thursday — read access
-- Attendance records are reviewed by OCF staff each week.
-- ============================================================================
CREATE POLICY "anon_read_fellowship_thursday"
    ON public.fellowship_thursday
    FOR SELECT TO anon
    USING (true);


-- ============================================================================
-- scholarship_history — read access
-- Past award history is used when assessing new applications.
-- ============================================================================
CREATE POLICY "anon_read_scholarship_history"
    ON public.scholarship_history
    FOR SELECT TO anon
    USING (true);
