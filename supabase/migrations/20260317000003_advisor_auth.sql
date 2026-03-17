-- ============================================================================
-- OCF Fellowship Management System — Advisor Auth Support
--
-- Extends public.advisor so it can act as both the staff profile table and
-- the authorization anchor for Supabase Auth.
--
-- IMPORTANT:
--   This repo does not contain the confirmed FGCU email addresses for the
--   existing advisor rows. Populate public.advisor.email with verified values
--   before enforcing a NOT NULL constraint in production.
-- ============================================================================

ALTER TABLE public.advisor
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS auth_user_id uuid,
    ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'advisor',
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

UPDATE public.advisor
SET email = lower(trim(email))
WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS advisor_email_key
    ON public.advisor (email)
    WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS advisor_auth_user_id_key
    ON public.advisor (auth_user_id)
    WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_advisor_is_active
    ON public.advisor (is_active);

CREATE OR REPLACE FUNCTION public.is_active_advisor()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.advisor
        WHERE auth_user_id = auth.uid()
          AND is_active = true
    );
$$;

REVOKE ALL ON FUNCTION public.is_active_advisor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_advisor() TO authenticated;

COMMENT ON COLUMN public.advisor.email IS
    'Supabase Auth login identity for the advisor. Backfill confirmed FGCU emails before enforcing NOT NULL.';

COMMENT ON COLUMN public.advisor.auth_user_id IS
    'Supabase Auth user ID linked on first successful sign-in.';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.advisor
        WHERE email IS NULL
    ) THEN
        RAISE NOTICE 'Advisor email backfill pending. Set confirmed FGCU emails in public.advisor.email before enforcing NOT NULL.';
    END IF;
END;
$$;
