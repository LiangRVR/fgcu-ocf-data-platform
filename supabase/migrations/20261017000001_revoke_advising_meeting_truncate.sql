-- ============================================================================
-- OCF Fellowship Management System — Close the normal-role TRUNCATE bypass on
-- the advising meeting history
--
-- Forward-only, privilege-only migration closing the independently-reviewed
-- database finding surfaced by `tests/contract/historical-audit-activity.test.ts`:
-- the append-only hardening of `advising_meeting` and its amendments removed
-- direct UPDATE/DELETE but never revoked TRUNCATE. TRUNCATE is a destructive
-- SQL path the local Supabase default privileges hand to `authenticated` (and
-- `anon`) for newly created objects, so a normal PostgREST-role session could
-- wipe the entire advising history even though row-level UPDATE/DELETE were
-- denied. The sibling historical tables already closed this exact gap in
-- `20261008000001_historical_integrity_remediation.sql`:
--
--     REVOKE TRUNCATE ON public.fellowship_thursday, public.scholarship_history
--         FROM authenticated;
--     REVOKE TRUNCATE ON public.fellowship_thursday_amendment,
--                        public.scholarship_history_amendment
--         FROM authenticated;
--
-- This migration applies the same closure to the two advising tables:
--
--     * `public.advising_meeting`
--     * `public.advising_meeting_amendment`
--
-- TRUNCATE is revoked from PUBLIC, `anon`, and `authenticated` (PUBLIC and anon
-- are revoked defensively in case a default/legacy grant exists). The trusted
-- technical `service_role` grant is left untouched, and no append-only
-- SELECT/INSERT behavior, RLS policy, audit trigger, business row, or audit row
-- is changed. Forward-only; no down migration.
-- ============================================================================

REVOKE TRUNCATE ON public.advising_meeting,
                   public.advising_meeting_amendment
    FROM PUBLIC, anon, authenticated;
