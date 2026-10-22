-- ============================================================================
-- OCF Fellowship Management System — Historical Integrity Remediation
--
-- Forward-only migration for AI-DLC change 2026-10-06-historical-integrity-
-- remediation. Fixes the release-handoff findings without weakening existing
-- authorization or losing legacy truthfulness:
--
--   1. `fellowship_thursday_amendment`: append-only, auditable corrections to
--      Fellowship Thursday attendance. The amendment references ONE immutable
--      original `attendance_id` and carries a reason, optional details, a
--      nullable `corrected_attended`, an explicit `corrects_source_info` flag,
--      and a nullable `corrected_source_info`. The explicit flag is what makes
--      a correction of `source_info` to NULL representable (a plain nullable
--      column cannot distinguish "leave unchanged" from "set to NULL"). At
--      least one field correction is required.
--   2. `scholarship_history_amendment`: append-only, auditable Correction /
--      Void amendments to Scholarship History awards. A Correction may adjust
--      the awarded `fellowship_id` without mutating the base row; a Void is a
--      TERMINAL action for normal operations — the base award stays auditable
--      but is excluded from effective/operational views. Once a Void exists on
--      a history row, no further amendment may be appended (the database
--      enforces terminal Void, not just convention).
--   3. Both base-history tables (`fellowship_thursday`, `scholarship_history`)
--      are locked down to explicit active-advisor SELECT/INSERT policies only:
--      no UPDATE or DELETE grant or policy remains for `authenticated`, and
--      correction/void flows move to the append-only amendment records.
--   4. `effective_fellowship_thursday` / `effective_scholarship_history`:
--      shared SECURITY INVOKER views that resolve deterministic effective
--      values for reporting and operational reads. Each corrected field uses
--      the NEWEST applicable amendment ordered by `(created_at, amendment_id)
--      DESC`; corrections are never counted as extra attendance rows.
--   5. Application hardening: the `stage_of_application` CHECK now accepts the
--      nine named stages (`Did Not Submit` and `Withdrawn` added as
--      non-finalist/non-awarded terminal stages), the denormalized
--      `is_semi_finalist`/`is_finalist` flags are pinned exactly consistent
--      with the stage by a production CHECK constraint, and `application_year`
--      is nullable but bounded to 2000–2100. Pre-existing data is validated
--      BEFORE the constraints are installed; no historical normalization is
--      ever performed.
--   6. New authenticated `advising_meeting` INSERTs require a conducting
--      `advisor_id` (database boundary guard). Existing NULL legacy/imported
--      rows stay valid and are never backfilled; trusted technical
--      (no-JWT/service) writes are unaffected; `created_by_advisor_id` remains
--      the separately-captured recorder.
--
-- Forward-only: no applied migration is edited or replayed. Reversal, if ever
-- required, is a NEW forward migration. No event dates or award cycles are
-- added (both remain deferred OCF decisions).
-- ============================================================================


-- ============================================================================
-- 1. fellowship_thursday_amendment (append-only corrections)
--
-- Columns follow the `advising_meeting_amendment` pattern: every amendment
-- carries database-authored `created_by_advisor_id` / `created_at` (client
-- values are forged and rejected) and a trim-aware non-blank `reason`.
-- `details` is optional (NULL when there is nothing further to say).
-- ============================================================================
CREATE SEQUENCE public.fellowship_thursday_amendment_amendment_id_seq;

CREATE TABLE public.fellowship_thursday_amendment (
    amendment_id integer NOT NULL DEFAULT nextval('public.fellowship_thursday_amendment_amendment_id_seq'::regclass) PRIMARY KEY,
    attendance_id integer NOT NULL REFERENCES public.fellowship_thursday (attendance_id),
    created_by_advisor_id integer NOT NULL REFERENCES public.advisor (advisor_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Trim set: space, tab, newline, carriage return, form feed, and vertical
    -- tab (hex \x0b — PostgreSQL has no \v escape). Mirrors the advising
    -- amendment trim-aware non-blank rule.
    reason text NOT NULL
        CONSTRAINT fellowship_thursday_amendment_reason_not_blank CHECK (btrim(reason, E' \t\n\r\f\x0b') <> ''),
    details text
        CONSTRAINT fellowship_thursday_amendment_details_not_blank CHECK (details IS NULL OR btrim(details, E' \t\n\r\f\x0b') <> ''),
    corrected_attended boolean,
    -- The explicit flag distinguishes "leave source unchanged" (false) from
    -- "correct source to NULL" (true, with corrected_source_info NULL). This
    -- is why a nullable column alone can never represent the correction.
    corrects_source_info boolean NOT NULL DEFAULT false,
    corrected_source_info character varying,
    -- At least one field correction is required per amendment.
    CONSTRAINT fellowship_thursday_amendment_at_least_one_correction CHECK (
        corrected_attended IS NOT NULL OR corrects_source_info
    ),
    -- corrected_source_info (when given) must be a known source code.
    CONSTRAINT fellowship_thursday_amendment_source_check CHECK (
        corrected_source_info IS NULL OR corrected_source_info::text = ANY (ARRAY['OCF', 'HC', 'MM'])
    ),
    -- A corrected source value is meaningless unless the flag announces it.
    CONSTRAINT fellowship_thursday_amendment_flag_source_consistency CHECK (
        corrects_source_info OR corrected_source_info IS NULL
    )
);

ALTER SEQUENCE public.fellowship_thursday_amendment_amendment_id_seq
    OWNED BY public.fellowship_thursday_amendment.amendment_id;

COMMENT ON TABLE public.fellowship_thursday_amendment IS
    'Append-only correction records for Fellowship Thursday attendance; a correction never alters the original attendance row and never counts as a new attendance record.';
COMMENT ON COLUMN public.fellowship_thursday_amendment.created_by_advisor_id IS
    'Database-resolved active advisor who recorded the amendment; client values are ignored.';
COMMENT ON COLUMN public.fellowship_thursday_amendment.created_at IS
    'Database-authored amendment entry timestamp; client values are ignored.';
COMMENT ON COLUMN public.fellowship_thursday_amendment.reason IS
    'Short explanation of why the correction is needed; must be non-empty after trimming whitespace (CHECK).';
COMMENT ON COLUMN public.fellowship_thursday_amendment.details IS
    'Optional correction details; when present must be non-empty after trimming whitespace (CHECK).';
COMMENT ON COLUMN public.fellowship_thursday_amendment.corrected_attended IS
    'Corrected attendance value, or NULL when attendance is not being corrected.';
COMMENT ON COLUMN public.fellowship_thursday_amendment.corrects_source_info IS
    'Explicit flag that the source field is being corrected; true allows an explicit correction of source_info to NULL (false always leaves source unchanged).';
COMMENT ON COLUMN public.fellowship_thursday_amendment.corrected_source_info IS
    'Corrected source code (OCF/HC/MM) or NULL for an explicit correction to no-known-source. Only read when corrects_source_info is true.';

-- Retrieval index for per-attendance amendment history: the leading
-- attendance_id covers FK lookups while created_at/amendment_id order each
-- attendance's correction chain chronologically (the same ordering the
-- effective-value views use to pick the newest applicable amendment).
DROP INDEX IF EXISTS public.idx_fellowship_thursday_amendment_attendance;
CREATE INDEX idx_fellowship_thursday_amendment_attendance
    ON public.fellowship_thursday_amendment (attendance_id, created_at, amendment_id);
CREATE INDEX idx_fellowship_thursday_amendment_created_by_advisor
    ON public.fellowship_thursday_amendment (created_by_advisor_id);


-- ============================================================================
-- 2. scholarship_history_amendment (append-only Correction / Void)
-- ============================================================================
CREATE SEQUENCE public.scholarship_history_amendment_amendment_id_seq;

CREATE TABLE public.scholarship_history_amendment (
    amendment_id integer NOT NULL DEFAULT nextval('public.scholarship_history_amendment_amendment_id_seq'::regclass) PRIMARY KEY,
    history_id integer NOT NULL REFERENCES public.scholarship_history (history_id),
    created_by_advisor_id integer NOT NULL REFERENCES public.advisor (advisor_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Controlled amendment vocabulary: Correction (factual adjustment) or Void
    -- (terminal exclusion from operational award counts; the base row remains
    -- auditable).
    amendment_type character varying NOT NULL
        CONSTRAINT scholarship_history_amendment_type_check CHECK (
            amendment_type::text = ANY (ARRAY['Correction', 'Void'])
        ),
    reason text NOT NULL
        CONSTRAINT scholarship_history_amendment_reason_not_blank CHECK (btrim(reason, E' \t\n\r\f\x0b') <> ''),
    details text
        CONSTRAINT scholarship_history_amendment_details_not_blank CHECK (details IS NULL OR btrim(details, E' \t\n\r\f\x0b') <> ''),
    -- Factual correction of the awarded program; never used by a Void.
    corrected_fellowship_id integer REFERENCES public.fellowship (fellowship_id),
    -- A Void is terminal: it cannot also restate or correct the award.
    CONSTRAINT scholarship_history_amendment_void_no_correction CHECK (
        amendment_type <> 'Void' OR corrected_fellowship_id IS NULL
    )
);

ALTER SEQUENCE public.scholarship_history_amendment_amendment_id_seq
    OWNED BY public.scholarship_history_amendment.amendment_id;

COMMENT ON TABLE public.scholarship_history_amendment IS
    'Append-only Correction/Void records for Scholarship History awards; amendments never mutate the original award row.';
COMMENT ON COLUMN public.scholarship_history_amendment.amendment_type IS
    'Controlled amendment vocabulary: Correction adjusts factual award details; Void terminally excludes the award from operational counts while keeping it auditable.';
COMMENT ON COLUMN public.scholarship_history_amendment.reason IS
    'Short explanation of why the amendment is needed; must be non-empty after trimming whitespace (CHECK).';
COMMENT ON COLUMN public.scholarship_history_amendment.details IS
    'Optional amendment details; when present must be non-empty after trimming whitespace (CHECK).';
COMMENT ON COLUMN public.scholarship_history_amendment.corrected_fellowship_id IS
    'Corrected awarded fellowship for a Correction amendment (NULL for Void amendments and for non-fellowship corrections).';

DROP INDEX IF EXISTS public.idx_scholarship_history_amendment_history;
CREATE INDEX idx_scholarship_history_amendment_history
    ON public.scholarship_history_amendment (history_id, created_at, amendment_id);
CREATE INDEX idx_scholarship_history_amendment_created_by_advisor
    ON public.scholarship_history_amendment (created_by_advisor_id);


-- ============================================================================
-- 3. Base-history lockdown: Fellowship Thursday and Scholarship History become
-- explicit active-advisor SELECT/INSERT tables. No authenticated UPDATE or
-- DELETE policy or grant remains; corrections/voids go through the amendments.
-- ============================================================================
DROP POLICY IF EXISTS "active_advisor_manage_fellowship_thursday" ON public.fellowship_thursday;

CREATE POLICY "active_advisor_select_fellowship_thursday"
    ON public.fellowship_thursday
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_fellowship_thursday"
    ON public.fellowship_thursday
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

REVOKE UPDATE, DELETE ON public.fellowship_thursday FROM authenticated;

DROP POLICY IF EXISTS "active_advisor_manage_scholarship_history" ON public.scholarship_history;

CREATE POLICY "active_advisor_select_scholarship_history"
    ON public.scholarship_history
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_scholarship_history"
    ON public.scholarship_history
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

REVOKE UPDATE, DELETE ON public.scholarship_history FROM authenticated;

-- No hard-delete path may remain for the base-history rows: TRUNCATE is a
-- destructive SQL path the Supabase default privileges otherwise hand to
-- `authenticated` for newly created objects, and PostgREST-style normal
-- operations never need it.
REVOKE TRUNCATE ON public.fellowship_thursday, public.scholarship_history
    FROM authenticated;


-- ============================================================================
-- 4. RLS + grants for the amendment tables (append-only, active-advisor only)
--
-- Both amendment tables are SELECT/INSERT-only for authenticated active
-- advisors, with no UPDATE/DELETE grants or policies. Sequences follow the
-- downstream revoke of the Supabase default grants (mirror the ...004 pattern).
-- ============================================================================
ALTER TABLE public.fellowship_thursday_amendment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scholarship_history_amendment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "active_advisor_select_fellowship_thursday_amendment"
    ON public.fellowship_thursday_amendment
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_fellowship_thursday_amendment"
    ON public.fellowship_thursday_amendment
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

CREATE POLICY "active_advisor_select_scholarship_history_amendment"
    ON public.scholarship_history_amendment
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_scholarship_history_amendment"
    ON public.scholarship_history_amendment
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

REVOKE ALL ON public.fellowship_thursday_amendment FROM anon;
GRANT SELECT, INSERT ON public.fellowship_thursday_amendment TO authenticated;
REVOKE UPDATE, DELETE ON public.fellowship_thursday_amendment FROM authenticated;

REVOKE ALL ON public.scholarship_history_amendment FROM anon;
GRANT SELECT, INSERT ON public.scholarship_history_amendment TO authenticated;
REVOKE UPDATE, DELETE ON public.scholarship_history_amendment FROM authenticated;

-- Append-only hard-delete closure: no normal TRUNCATE path on the amendments.
REVOKE TRUNCATE ON public.fellowship_thursday_amendment, public.scholarship_history_amendment
    FROM authenticated;

REVOKE ALL ON SEQUENCE public.fellowship_thursday_amendment_amendment_id_seq
    FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.fellowship_thursday_amendment_amendment_id_seq TO authenticated;

REVOKE ALL ON SEQUENCE public.scholarship_history_amendment_amendment_id_seq
    FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.scholarship_history_amendment_amendment_id_seq TO authenticated;


-- ============================================================================
-- 5. Amendment creation-metadata triggers
--
-- SECURITY DEFINER with an empty search_path and fully qualified relations
-- (same hardened pattern as the advising amendment trigger): the database —
-- never the client payload — is authoritative for `created_by_advisor_id` and
-- `created_at`, and the rows are append-only (UPDATE denied). A Void is
-- terminal: no further amendment may be appended to a voided history row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_fellowship_thursday_amendment_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_creator_advisor_id integer;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'fellowship_thursday_amendment records are append-only and cannot be modified';
    END IF;

    SELECT a.advisor_id
      INTO v_creator_advisor_id
      FROM public.advisor a
     WHERE a.auth_user_id = auth.uid()
       AND a.is_active = true
     LIMIT 1;

    IF v_creator_advisor_id IS NULL THEN
        RAISE EXCEPTION 'only an authenticated active advisor can create a fellowship Thursday amendment'
            USING ERRCODE = '42501';
    END IF;

    NEW.created_by_advisor_id := v_creator_advisor_id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_fellowship_thursday_amendment_metadata()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_fellowship_thursday_amendment_metadata()
    TO service_role;

CREATE TRIGGER trg_fellowship_thursday_amendment_created_metadata
    BEFORE INSERT OR UPDATE ON public.fellowship_thursday_amendment
    FOR EACH ROW
    EXECUTE FUNCTION public.set_fellowship_thursday_amendment_metadata();

CREATE OR REPLACE FUNCTION public.set_scholarship_history_amendment_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_creator_advisor_id integer;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'scholarship_history_amendment records are append-only and cannot be modified';
    END IF;

    -- Void amendments are terminal: a Correction may precede a Void (correct,
    -- then void), but once ANY Void exists on the award no further amendment
    -- (not even another Void) may be appended — the award stays auditable and
    -- is excluded from operational counts forever.
    IF EXISTS (
        SELECT 1
          FROM public.scholarship_history_amendment a
         WHERE a.history_id = NEW.history_id
           AND a.amendment_type = 'Void'
    ) THEN
        RAISE EXCEPTION 'scholarship history award % is already voided; Void is terminal and no further amendment may be appended', NEW.history_id
            USING ERRCODE = '42501';
    END IF;

    SELECT a.advisor_id
      INTO v_creator_advisor_id
      FROM public.advisor a
     WHERE a.auth_user_id = auth.uid()
       AND a.is_active = true
     LIMIT 1;

    IF v_creator_advisor_id IS NULL THEN
        RAISE EXCEPTION 'only an authenticated active advisor can create a scholarship history amendment'
            USING ERRCODE = '42501';
    END IF;

    NEW.created_by_advisor_id := v_creator_advisor_id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_scholarship_history_amendment_metadata()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_scholarship_history_amendment_metadata()
    TO service_role;

CREATE TRIGGER trg_scholarship_history_amendment_created_metadata
    BEFORE INSERT OR UPDATE ON public.scholarship_history_amendment
    FOR EACH ROW
    EXECUTE FUNCTION public.set_scholarship_history_amendment_metadata();


-- ============================================================================
-- 6. Effective-value views (shared SECURITY INVOKER data boundary)
--
-- SECURITY INVOKER so the views can never bypass the underlying RLS. Each
-- corrected field resolves to the NEWEST applicable amendment ordered by
-- `(created_at, amendment_id) DESC`; a LATERAL with an explicit `corrected`
-- marker keeps an explicit correction-to-NULL representable (a plain COALESCE
-- would wrongly fall back to the base value).
--
-- The reporting and operational reads must consume these views — never raw
-- base rows plus amendment rows — so correction rows can never inflate
-- attendance counts.
-- ============================================================================
CREATE OR REPLACE VIEW public.effective_fellowship_thursday
WITH (security_invoker = on)
AS
SELECT
    ft.attendance_id,
    ft.student_id,
    ft.attended   AS base_attended,
    ft.source_info AS base_source_info,
    CASE WHEN att.corrected THEN att.corrected_attended ELSE ft.attended END AS attended,
    CASE WHEN src.corrected THEN src.corrected_source_info ELSE ft.source_info END AS source_info,
    (COALESCE(att.corrected, false) OR COALESCE(src.corrected, false)) AS has_amendments
FROM public.fellowship_thursday ft
LEFT JOIN LATERAL (
    SELECT a.corrected_attended, true AS corrected
      FROM public.fellowship_thursday_amendment a
     WHERE a.attendance_id = ft.attendance_id
       AND a.corrected_attended IS NOT NULL
     ORDER BY a.created_at DESC, a.amendment_id DESC
     LIMIT 1
) att ON true
LEFT JOIN LATERAL (
    SELECT a.corrected_source_info, true AS corrected
      FROM public.fellowship_thursday_amendment a
     WHERE a.attendance_id = ft.attendance_id
       AND a.corrects_source_info
     ORDER BY a.created_at DESC, a.amendment_id DESC
     LIMIT 1
) src ON true;

COMMENT ON VIEW public.effective_fellowship_thursday IS
    'Effective Fellowship Thursday attendance values: the latest applicable amendment per corrected field, ordered by (created_at, amendment_id) descending, over the immutable base row. Corrections are never extra attendance rows. SECURITY INVOKER: cannot bypass RLS.';

CREATE OR REPLACE VIEW public.effective_scholarship_history
WITH (security_invoker = on)
AS
SELECT
    sh.history_id,
    sh.student_id,
    sh.fellowship_id AS base_fellowship_id,
    COALESCE(fix.corrected_fellowship_id, sh.fellowship_id) AS fellowship_id,
    (fix.amendment_id IS NOT NULL) AS has_correction,
    (void.amendment_id IS NOT NULL) AS is_voided,
    void.amendment_id AS void_amendment_id,
    void.voided_at,
    void.voided_by_advisor_id
FROM public.scholarship_history sh
LEFT JOIN LATERAL (
    SELECT a.amendment_id, a.corrected_fellowship_id
      FROM public.scholarship_history_amendment a
     WHERE a.history_id = sh.history_id
       AND a.amendment_type = 'Correction'
       AND a.corrected_fellowship_id IS NOT NULL
     ORDER BY a.created_at DESC, a.amendment_id DESC
     LIMIT 1
) fix ON true
LEFT JOIN LATERAL (
    SELECT a.amendment_id, a.created_at AS voided_at, a.created_by_advisor_id AS voided_by_advisor_id
      FROM public.scholarship_history_amendment a
     WHERE a.history_id = sh.history_id
       AND a.amendment_type = 'Void'
     ORDER BY a.created_at DESC, a.amendment_id DESC
     LIMIT 1
) void ON true;

COMMENT ON VIEW public.effective_scholarship_history IS
    'Effective Scholarship History award values: the latest applicable Correction determines fellowship_id; a Void (terminal — see scholarship_history_amendment) excludes the award from operational counts while the base row stays auditable. SECURITY INVOKER: cannot bypass RLS.';

REVOKE ALL ON public.effective_fellowship_thursday FROM anon;
REVOKE ALL ON public.effective_scholarship_history FROM anon;
GRANT SELECT ON public.effective_fellowship_thursday TO authenticated;
GRANT SELECT ON public.effective_scholarship_history TO authenticated;


-- ============================================================================
-- 7. Application hardening: nine named stages + flag consistency + year bounds
--
-- Before the constraints are installed the existing data is validated. If any
-- legacy row violates the nine-stage vocabulary, the stage/flag invariant, or
-- the 2000–2100 year bound, the migration FAILS LOUDLY instead of normalizing
-- silently: resolving incompatible historical data is a product decision, not
-- a migration side effect.
-- ============================================================================
DO $$
DECLARE
    v_bad integer;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.application
     WHERE stage_of_application::text <> ALL (ARRAY[
            'Started', 'Submitted', 'Under Review', 'Did Not Submit',
            'Semi-Finalist', 'Finalist', 'Awarded', 'Rejected', 'Withdrawn'
        ]);
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'application stage vocabulary: % row(s) use an unlisted stage; resolve before installing the nine-stage CHECK (no normalization performed)', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM public.application
     WHERE NOT (
            (stage_of_application::text IN ('Started','Submitted','Under Review','Did Not Submit','Rejected','Withdrawn')
             AND is_semi_finalist = false AND is_finalist = false)
         OR (stage_of_application::text = 'Semi-Finalist' AND is_semi_finalist = true AND is_finalist = false)
         OR (stage_of_application::text IN ('Finalist','Awarded') AND is_semi_finalist = true AND is_finalist = true)
        );
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'application stage/flag invariant: % row(s) are inconsistent; resolve before installing the flag-consistency CHECK (no normalization performed)', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM public.application
     WHERE application_year IS NOT NULL
       AND (application_year < 2000 OR application_year > 2100);
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'application_year: % row(s) fall outside 2000–2100; resolve before installing the year-bound CHECK (no normalization performed)', v_bad;
    END IF;
END;
$$;

-- Replace the seven-stage vocabulary with the nine-stage vocabulary.
ALTER TABLE public.application
    DROP CONSTRAINT IF EXISTS application_stage_check;

ALTER TABLE public.application
    ADD CONSTRAINT application_stage_check CHECK (
        stage_of_application::text = ANY (ARRAY[
            'Started', 'Submitted', 'Under Review', 'Did Not Submit',
            'Semi-Finalist', 'Finalist', 'Awarded', 'Rejected', 'Withdrawn'
        ])
    );

-- The denormalized flags must be exactly consistent with the stage. This is
-- the PRODUCTION enforcement of the invariant (it supersedes the test-lane
-- support constraint that used to be the only local enforcement).
ALTER TABLE public.application
    ADD CONSTRAINT application_stage_flag_consistency_check CHECK (
        (stage_of_application::text IN ('Started', 'Submitted', 'Under Review', 'Did Not Submit', 'Rejected', 'Withdrawn')
         AND is_semi_finalist = false AND is_finalist = false)
        OR (stage_of_application::text = 'Semi-Finalist' AND is_semi_finalist = true AND is_finalist = false)
        OR (stage_of_application::text IN ('Finalist', 'Awarded') AND is_semi_finalist = true AND is_finalist = true)
    );

-- application_year is nullable (legacy rows keep a truthful NULL cycle) but
-- when present must be within 2000–2100.
ALTER TABLE public.application
    ADD CONSTRAINT application_year_range_check CHECK (
        application_year IS NULL OR (application_year >= 2000 AND application_year <= 2100)
    );

COMMENT ON CONSTRAINT application_stage_check ON public.application IS
    'The nine supported application stages including the terminal Did Not Submit and Withdrawn states.';
COMMENT ON CONSTRAINT application_stage_flag_consistency_check ON public.application IS
    'Production enforcement: stage_of_application and the denormalized is_semi_finalist/is_finalist flags must match lib/applications/pipeline.ts (early/terminal stages => ff, Semi-Finalist => tf, Finalist/Awarded => tt).';
COMMENT ON CONSTRAINT application_year_range_check ON public.application IS
    'application_year is nullable (legacy truth) and bounded to 2000–2100 when present; no historical year is ever guessed.';


-- ============================================================================
-- 8. New authenticated advising-meeting writes require a conducting advisor
--
-- A database boundary guard (not client validation): an authenticated INSERT
-- with a NULL `advisor_id` is rejected fail-closed, while trusted technical
-- (no-JWT/service-role and seed) INSERTs stay allowed and legacy/imported
-- NULL rows remain untouched (no backfill). The RLS INSERT policy remains the
-- authorization gate for active advisors; `created_by_advisor_id` is still
-- captured separately by the existing creation-metadata trigger.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_advising_meeting_advisor_required()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- auth.uid() is non-NULL for an authenticated session and NULL for trusted
    -- technical (service/seed) writes. Only the authenticated path must name
    -- the conducting advisor; existing NULL legacy rows are never backfilled.
    IF auth.uid() IS NOT NULL AND NEW.advisor_id IS NULL THEN
        RAISE EXCEPTION 'a new authenticated advising meeting requires a conducting advisor_id; legacy NULL-advisor rows remain untouched'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advising_meeting_advisor_required()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_advising_meeting_advisor_required()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advising_meeting_advisor_required
    ON public.advising_meeting;

CREATE TRIGGER trg_advising_meeting_advisor_required
    BEFORE INSERT ON public.advising_meeting
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advising_meeting_advisor_required();

COMMENT ON FUNCTION public.guard_advising_meeting_advisor_required() IS
    'DB boundary guard (R8): authenticated new advising-meeting INSERTs require a conducting advisor_id; trusted technical INSERTs and legacy NULL rows are preserved.';