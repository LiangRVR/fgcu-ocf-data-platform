-- ============================================================================
-- Allow Anonymous Read Access
-- This migration adds RLS policies to allow the anonymous (anon) role
-- to read data from all tables for development purposes
-- ============================================================================

-- ============================================================================
-- Drop existing restrictive policies
-- ============================================================================
DROP POLICY IF EXISTS "Students can view own record" ON public.students;
DROP POLICY IF EXISTS "Authenticated users can view fellowships" ON public.fellowships;
DROP POLICY IF EXISTS "Students can view own applications" ON public.applications;

-- ============================================================================
-- Add permissive read policies for anonymous users
-- ============================================================================

-- Allow anonymous users to read all students
CREATE POLICY "Allow anonymous read access to students"
ON public.students
FOR SELECT
TO anon
USING (true);

-- Allow anonymous users to read all fellowships
CREATE POLICY "Allow anonymous read access to fellowships"
ON public.fellowships
FOR SELECT
TO anon
USING (true);

-- Allow anonymous users to read all applications
CREATE POLICY "Allow anonymous read access to applications"
ON public.applications
FOR SELECT
TO anon
USING (true);

-- Allow anonymous users to read all advising sessions
CREATE POLICY "Allow anonymous read access to advising_sessions"
ON public.advising_sessions
FOR SELECT
TO anon
USING (true);

-- Allow anonymous users to read all application reviews
CREATE POLICY "Allow anonymous read access to application_reviews"
ON public.application_reviews
FOR SELECT
TO anon
USING (true);

-- Allow anonymous users to read all users
CREATE POLICY "Allow anonymous read access to users"
ON public.users
FOR SELECT
TO anon
USING (true);

-- ============================================================================
-- Add policies for existing database schema (if different table names)
-- These will only apply if the tables exist
-- ============================================================================

-- For legacy/existing schema compatibility
DO $$
BEGIN
    -- Check if 'student' table exists (without 's')
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'student') THEN
        EXECUTE 'ALTER TABLE public.student ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to student" ON public.student FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'fellowship' table exists (without 's')
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fellowship') THEN
        EXECUTE 'ALTER TABLE public.fellowship ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to fellowship" ON public.fellowship FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'application' table exists (without 's')
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'application') THEN
        EXECUTE 'ALTER TABLE public.application ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to application" ON public.application FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'advising_meeting' table exists
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'advising_meeting') THEN
        EXECUTE 'ALTER TABLE public.advising_meeting ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to advising_meeting" ON public.advising_meeting FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'advisor' table exists
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'advisor') THEN
        EXECUTE 'ALTER TABLE public.advisor ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to advisor" ON public.advisor FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'fellowship_thursday' table exists
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'fellowship_thursday') THEN
        EXECUTE 'ALTER TABLE public.fellowship_thursday ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to fellowship_thursday" ON public.fellowship_thursday FOR SELECT TO anon USING (true)';
    END IF;

    -- Check if 'scholarship_history' table exists
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'scholarship_history') THEN
        EXECUTE 'ALTER TABLE public.scholarship_history ENABLE ROW LEVEL SECURITY';
        EXECUTE 'CREATE POLICY "Allow anonymous read access to scholarship_history" ON public.scholarship_history FOR SELECT TO anon USING (true)';
    END IF;
END $$;

-- ============================================================================
-- Grant necessary permissions to anon role
-- ============================================================================
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- Note: For production, you should implement more granular policies
-- based on your security requirements. This migration is for development.
