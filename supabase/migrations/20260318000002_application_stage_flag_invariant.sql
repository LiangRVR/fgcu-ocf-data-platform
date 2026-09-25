-- ============================================================================
-- OCF Fellowship Management System — Application Stage/Flag Invariant
--
-- Forward-only, LOCAL-TEST-ONLY migration (hardening plan Work 2, R3).
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
-- This migration adds a CHECK constraint that mirrors that mapping exactly,
-- so invalid stage/flag combinations fail at the database layer even when
-- written directly through the API (bypassing UI/application validation).
--
-- Forward-only: it only ADDs one CHECK constraint (DROP CONSTRAINT IF EXISTS
-- first keeps it idempotent on re-apply); no tables, columns, or data are
-- touched. It is validated ONLY against the disposable Docker-local contract
-- lane and is NOT authorized for production deployment (production schema
-- remains frozen per the production-schema-provenance authority decision).
-- Enforcement is a CHECK constraint, not a trigger.
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
    'Forward-only local invariant: stage_of_application and the denormalized is_semi_finalist/is_finalist flags must match lib/applications/pipeline.ts (Started/Submitted/Under Review/Rejected => ff, Semi-Finalist => tf, Finalist/Awarded => tt). Not authorized for production deployment.';