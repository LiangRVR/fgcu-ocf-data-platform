-- ============================================================================
-- OCF Fellowship Management System — Application Stage/Flag Invariant
--
-- TEST-ONLY SQL — NOT a migration. This file deliberately lives OUTSIDE
-- `supabase/migrations/` and is NEVER part of a deployable migration chain
-- (oracle P1 fix): the application stage/flag invariant must not remain in any
-- production-deployable migration path.
--
-- The isolated contract (`scripts/contract/run.mjs`) and E2E
-- (`scripts/e2e/run.mjs`) lanes apply this file AFTER the normal
-- production-equivalent migration chain has been applied by
-- `supabase db reset --no-seed` (via `scripts/test-support/apply-test-only-sql.mjs`).
--
-- The `application` table stores a denormalized pipeline position:
--   stage_of_application  (controlled vocabulary)
--   is_semi_finalist      (boolean)
--   is_finalist           (boolean)
--
-- The two boolean flags duplicate information already implied by the stage,
-- and must stay exactly consistent with it. The authoritative mapping lives
-- in lib/applications/pipeline.ts (`deriveFlags` / `validateConsistency`):
--
--   Started / Submitted / Under Review / Rejected  ->  sf=false, f=false
--   Semi-Finalist                                  ->  sf=true,  f=false
--   Finalist / Awarded                             ->  sf=true,  f=true
--
-- This file adds a CHECK constraint that mirrors that mapping exactly,
-- so invalid stage/flag combinations fail at the database layer even when
-- written directly through the API (bypassing UI/application validation).
--
-- It only ADDs one CHECK constraint (DROP CONSTRAINT IF EXISTS first keeps it
-- idempotent on re-apply); no tables, columns, or data are touched. It is
-- validated ONLY against the disposable Docker-local contract/E2E lanes and
-- is NOT authorized for production deployment (production schema remains
-- frozen per the production-schema-provenance authority decision). Enforcement
-- is a CHECK constraint, not a trigger.
-- ============================================================================

ALTER TABLE public.application
    DROP CONSTRAINT IF EXISTS application_stage_flag_invariant_check;

ALTER TABLE public.application
    ADD CONSTRAINT application_stage_flag_invariant_check CHECK (
        -- stage must be one of the seven supported pipeline stages
        stage_of_application::text = ANY (ARRAY[
            'Started', 'Submitted', 'Under Review',
            'Semi-Finalist', 'Finalist', 'Awarded', 'Rejected'
        ])
        AND (
            -- early stages (and Rejected) carry neither flag
            (
                stage_of_application::text IN ('Started', 'Submitted', 'Under Review', 'Rejected')
                AND is_semi_finalist = false
                AND is_finalist = false
            )
            OR (
                -- Semi-Finalist is a semi-finalist, never yet a finalist
                stage_of_application::text = 'Semi-Finalist'
                AND is_semi_finalist = true
                AND is_finalist = false
            )
            OR (
                -- Finalist and Awarded imply both flags
                stage_of_application::text IN ('Finalist', 'Awarded')
                AND is_semi_finalist = true
                AND is_finalist = true
            )
        )
    );

COMMENT ON CONSTRAINT application_stage_flag_invariant_check ON public.application IS
    'TEST-ONLY local invariant (applied by the isolated contract/E2E lanes after the production-equivalent migration chain): stage_of_application and the denormalized is_semi_finalist/is_finalist flags must match lib/applications/pipeline.ts (Started/Submitted/Under Review/Rejected => ff, Semi-Finalist => tf, Finalist/Awarded => tt). Not a production migration.';