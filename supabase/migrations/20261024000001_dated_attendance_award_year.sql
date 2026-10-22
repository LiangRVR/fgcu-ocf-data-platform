-- ============================================================================
-- OCF Fellowship Management System — Dated Fellowship Thursday + award year
--
-- Forward-only, additive migration for the approved AI-DLC change
-- `dated-attendance-award-year`. It makes the two confirmed OCF identifiers
-- explicit for future operational history while preserving genuinely unknown
-- legacy values:
--
--   1. `public.fellowship_thursday.event_date date` — the calendar date of the
--      weekly Fellowship Thursday event. Nullable: existing rows keep a truthful
--      NULL (never inferred, never backfilled). PostgreSQL's `date` type is the
--      calendar-validity authority; no weekday/timestamp/time-zone rule exists.
--   2. `public.scholarship_history.award_year integer` — the four-digit award
--      year. Nullable with a null-tolerant CHECK bounded to 1000–9999 so legacy
--      unknown years stay NULL while any supplied year must be well-formed.
--   3. Two authenticated-insert boundary guards: a new operational base record
--      created through a normal product path (a request carries `auth.uid()`)
--      is rejected fail-closed unless it supplies the identifier. Trusted
--      technical (no-JWT service/import/seed) inserts keep the legacy NULL
--      compatibility, and existing NULL rows are never touched.
--   4. The immutable base columns are appended to the shared SECURITY INVOKER
--      effective views and to the read-only list views, preserving their
--      existing security-invoker option, grants, one-row-per-base-row behavior,
--      and correction/Void logic.
--   5. The internal historical audit helper snapshot allowlist is extended so a
--      successful new base insert atomically records the structural identifier
--      in its immutable `created` event. Amendments and browser audit
--      presentation are deliberately unchanged.
--
-- Both identifiers are immutable base facts: a correction/amendment cannot add
-- or change them (the base tables remain authenticated SELECT/INSERT-only with
-- no UPDATE path, and the amendment tables do not reference the new columns).
--
-- Preserved unchanged: forward-only migration history, immutable audit/history,
-- append-only base/amendment records, RLS policies and grants, safe audit
-- projections, and effective correction/Void semantics. No existing business
-- row, policy, grant, or audit row is edited, deleted, or reset. No down
-- migration: a defect found after application is remediated by a later forward
-- migration.
-- ============================================================================


-- ============================================================================
-- 1. Nullable immutable base columns
--
-- `event_date` (date) and `award_year` (four-digit integer) are added without a
-- DEFAULT so every pre-existing row keeps an explicit NULL. The award-year
-- bound is null-tolerant: NULL is allowed (legacy truth) and any non-NULL value
-- must fall within 1000–9999.
-- ============================================================================
ALTER TABLE public.fellowship_thursday
    ADD COLUMN IF NOT EXISTS event_date date;

COMMENT ON COLUMN public.fellowship_thursday.event_date IS
    'Calendar date of the weekly Fellowship Thursday event (date only). Required for new authenticated operational inserts; NULL is preserved legacy/unknown truth and is never inferred or backfilled.';

ALTER TABLE public.scholarship_history
    ADD COLUMN IF NOT EXISTS award_year integer;

-- `ADD CONSTRAINT` has no `IF NOT EXISTS` form, so the null-tolerant bound is
-- installed only when absent. This keeps the migration conflict-idempotent when
-- the forward-only chain is replayed against an already-upgraded schema.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'scholarship_history'
           AND c.conname = 'scholarship_history_award_year_range_check'
    ) THEN
        ALTER TABLE public.scholarship_history
            ADD CONSTRAINT scholarship_history_award_year_range_check CHECK (
                award_year IS NULL OR (award_year >= 1000 AND award_year <= 9999)
            );
    END IF;
END;
$$;

COMMENT ON COLUMN public.scholarship_history.award_year IS
    'Four-digit award year of the scholarship award (1000–9999). Required for new authenticated operational inserts; NULL is preserved legacy/unknown truth and is never inferred or backfilled.';

COMMENT ON CONSTRAINT scholarship_history_award_year_range_check ON public.scholarship_history IS
    'award_year is nullable (legacy truth) and bounded to 1000–9999 when present; no historical year is ever guessed.';


-- ============================================================================
-- 2. Authenticated new-record boundary guards
--
-- A database boundary guard (not client validation): an authenticated INSERT
-- (auth.uid() non-NULL) that omits the identifier is rejected fail-closed with
-- 42501, while trusted technical (no-JWT service/import/seed) INSERTs remain
-- allowed and existing NULL legacy rows are never backfilled. This mirrors the
-- existing `guard_advising_meeting_advisor_required` pattern: SECURITY INVOKER,
-- empty search_path, fully qualified references, EXECUTE revoked from
-- PUBLIC/anon/authenticated and pinned to service_role only.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_fellowship_thursday_event_date_required()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND NEW.event_date IS NULL THEN
        RAISE EXCEPTION 'a new authenticated fellowship Thursday attendance requires an event_date; legacy NULL rows remain untouched'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_fellowship_thursday_event_date_required()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_fellowship_thursday_event_date_required()
    TO service_role;

DROP TRIGGER IF EXISTS trg_fellowship_thursday_event_date_required
    ON public.fellowship_thursday;

CREATE TRIGGER trg_fellowship_thursday_event_date_required
    BEFORE INSERT ON public.fellowship_thursday
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_fellowship_thursday_event_date_required();

COMMENT ON FUNCTION public.guard_fellowship_thursday_event_date_required() IS
    'DB boundary guard: a new authenticated Fellowship Thursday INSERT requires an event_date; trusted technical INSERTs and legacy NULL rows are preserved.';

CREATE OR REPLACE FUNCTION public.guard_scholarship_history_award_year_required()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND NEW.award_year IS NULL THEN
        RAISE EXCEPTION 'a new authenticated scholarship history award requires an award_year; legacy NULL rows remain untouched'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_scholarship_history_award_year_required()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_scholarship_history_award_year_required()
    TO service_role;

DROP TRIGGER IF EXISTS trg_scholarship_history_award_year_required
    ON public.scholarship_history;

CREATE TRIGGER trg_scholarship_history_award_year_required
    BEFORE INSERT ON public.scholarship_history
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_scholarship_history_award_year_required();

COMMENT ON FUNCTION public.guard_scholarship_history_award_year_required() IS
    'DB boundary guard: a new authenticated Scholarship History INSERT requires a four-digit award_year; trusted technical INSERTs and legacy NULL rows are preserved.';


-- ============================================================================
-- 3. Effective-value views: append the immutable base identifiers
--
-- The base identifiers are immutable base facts, so no amendment resolution is
-- introduced. The new columns are appended so existing consumers keep their
-- column contract; SECURITY INVOKER, one-row-per-base-row behavior, and the
-- correction/Void semantics are unchanged.
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
    (COALESCE(att.corrected, false) OR COALESCE(src.corrected, false)) AS has_amendments,
    ft.event_date
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
    'Effective Fellowship Thursday attendance values: the latest applicable amendment per corrected field, ordered by (created_at, amendment_id) descending, over the immutable base row (including the immutable calendar event_date). Corrections are never extra attendance rows. SECURITY INVOKER: cannot bypass RLS.';

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
    void.voided_by_advisor_id,
    sh.award_year
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
    'Effective Scholarship History award values: the latest applicable Correction determines fellowship_id; a Void (terminal) excludes the award from operational counts while the base row stays auditable; the immutable award_year is exposed unchanged. SECURITY INVOKER: cannot bypass RLS.';

REVOKE ALL ON public.effective_fellowship_thursday FROM anon;
REVOKE ALL ON public.effective_scholarship_history FROM anon;
GRANT SELECT ON public.effective_fellowship_thursday TO authenticated;
GRANT SELECT ON public.effective_scholarship_history TO authenticated;


-- ============================================================================
-- 4. List views: append the immutable base identifiers
--
-- Read-only, SECURITY INVOKER, explicit columns; the new base identifiers are
-- appended after the existing flattened display columns so existing consumers
-- keep their column contract and the views remain one row per base row.
-- ============================================================================
CREATE OR REPLACE VIEW public.fellowship_thursday_list
WITH (security_invoker = on)
AS
SELECT
    e.attendance_id,
    e.student_id,
    e.base_attended,
    e.base_source_info,
    e.attended,
    e.source_info,
    e.has_amendments,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = e.student_id
    ) AS student_name,
    e.event_date
FROM public.effective_fellowship_thursday e;

COMMENT ON VIEW public.fellowship_thursday_list IS
    'Explicit-column, read-only, SECURITY INVOKER Fellowship Thursday list source backed by the effective-value view: one row per attendance with corrected attended/source values, base audit values, and the immutable calendar event_date. No Auth binding data.';

REVOKE ALL ON public.fellowship_thursday_list FROM anon, authenticated;
GRANT SELECT ON public.fellowship_thursday_list TO authenticated;

CREATE OR REPLACE VIEW public.scholarship_history_list
WITH (security_invoker = on)
AS
SELECT
    e.history_id,
    e.student_id,
    e.base_fellowship_id,
    e.fellowship_id,
    e.has_correction,
    e.is_voided,
    e.voided_at,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = e.student_id
    ) AS student_name,
    (
        SELECT f.fellowship_name
          FROM public.fellowship f
         WHERE f.fellowship_id = e.fellowship_id
    ) AS fellowship_name,
    e.award_year
FROM public.effective_scholarship_history e;

COMMENT ON VIEW public.scholarship_history_list IS
    'Explicit-column, read-only, SECURITY INVOKER Scholarship History list source backed by the effective-value view: corrected effective fellowship_id, base_fellowship_id for audit, has_correction/is_voided/voided_at, the immutable award_year, and flattened student/fellowship names. No Auth binding data.';

REVOKE ALL ON public.scholarship_history_list FROM anon, authenticated;
GRANT SELECT ON public.scholarship_history_list TO authenticated;


-- ============================================================================
-- 5. Historical audit snapshot keys
--
-- The internal SECURITY DEFINER trigger helper is recreated with exactly the
-- behavior of migration 20261015000002, extended so a successful base insert
-- records the new structural identifier ('event_date' / 'award_year') in its
-- immutable `created` event. No amendment snapshot, no narrative content, and
-- no browser audit projection changes. The reserved entity/action vocabulary
-- and the existing indexes already cover these values.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.audit_historical_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_actor_advisor_id integer;
    v_actor_name text;
    v_trigger_actor_id integer;
    v_trigger_actor_name text;
    v_origin text;
    v_entity_type text;
    v_action text;
    v_entity_id integer;
    v_subject_student_id integer;
    v_subject_application_id integer;
    v_subject_fellowship_id integer;
    v_new_values jsonb;
BEGIN
    -- This helper is wired to historical INSERTs only.
    IF TG_OP <> 'INSERT' THEN
        RETURN NULL;
    END IF;

    v_entity_type := TG_TABLE_NAME;
    v_actor := auth.uid();

    -- -----------------------------------------------------------------------
    -- Actor resolution and origin classification (identical trusted
    -- provenance logic to the existing audit helpers): a non-null request
    -- actor must resolve to exactly one active, pre-bound advisor; otherwise a
    -- verified transaction-local trusted actor is used; otherwise System.
    -- -----------------------------------------------------------------------
    IF v_actor IS NOT NULL THEN
        IF (
            SELECT count(*)::integer
              FROM public.advisor AS a
             WHERE a.auth_user_id = v_actor
               AND a.is_active = true
        ) <> 1 THEN
            RAISE EXCEPTION
                'authenticated actor has no unique active bound advisor; audit write refused'
                USING ERRCODE = '42501';
        END IF;

        SELECT a.advisor_id, a.advisor_name
          INTO v_actor_advisor_id, v_actor_name
          FROM public.advisor AS a
         WHERE a.auth_user_id = v_actor
           AND a.is_active = true;

        v_origin := 'user';
    ELSE
        v_trigger_actor_id :=
            nullif(current_setting('ocf.audit_actor_id', true), '')::integer;
        v_trigger_actor_name :=
            nullif(current_setting('ocf.audit_actor_name', true), '');

        IF v_trigger_actor_id IS NOT NULL AND v_trigger_actor_name IS NOT NULL THEN
            PERFORM private.assert_durable_effective_admin(v_trigger_actor_id);
            v_actor_advisor_id := v_trigger_actor_id;
            v_actor_name := v_trigger_actor_name;
            v_origin := 'user';
        ELSE
            v_actor_advisor_id := NULL;
            v_actor_name := 'System';
            v_origin := 'system';
        END IF;
    END IF;

    -- -----------------------------------------------------------------------
    -- Explicit structural snapshots. NO notes, amendment reason/details,
    -- credentials, claims, tokens, or passwords ever enter a payload.
    -- -----------------------------------------------------------------------
    IF v_entity_type = 'advising_meeting' THEN
        v_action := 'created';
        v_entity_id := NEW.meeting_id;
        v_subject_student_id := NEW.student_id;
        v_subject_application_id := NEW.application_id;
        v_new_values := jsonb_build_object(
            'meeting_id', NEW.meeting_id,
            'student_id', NEW.student_id,
            'advisor_id', NEW.advisor_id,
            'application_id', NEW.application_id,
            'meeting_date', NEW.meeting_date,
            'meeting_mode', NEW.meeting_mode,
            'no_show', NEW.no_show
        );
    ELSIF v_entity_type = 'advising_meeting_amendment' THEN
        v_action := 'correction_added';
        v_entity_id := NEW.amendment_id;
        SELECT m.student_id, m.application_id
          INTO v_subject_student_id, v_subject_application_id
          FROM public.advising_meeting AS m
         WHERE m.meeting_id = NEW.meeting_id;
        v_new_values := jsonb_build_object(
            'amendment_id', NEW.amendment_id,
            'meeting_id', NEW.meeting_id
        );
    ELSIF v_entity_type = 'fellowship_thursday' THEN
        v_action := 'created';
        v_entity_id := NEW.attendance_id;
        v_subject_student_id := NEW.student_id;
        v_new_values := jsonb_build_object(
            'attendance_id', NEW.attendance_id,
            'student_id', NEW.student_id,
            'attended', NEW.attended,
            'source_info', NEW.source_info,
            'event_date', NEW.event_date
        );
    ELSIF v_entity_type = 'fellowship_thursday_amendment' THEN
        v_action := 'correction_added';
        v_entity_id := NEW.amendment_id;
        SELECT b.student_id
          INTO v_subject_student_id
          FROM public.fellowship_thursday AS b
         WHERE b.attendance_id = NEW.attendance_id;
        v_new_values := jsonb_build_object(
            'amendment_id', NEW.amendment_id,
            'attendance_id', NEW.attendance_id,
            'corrected_attended', NEW.corrected_attended,
            'corrects_source_info', NEW.corrects_source_info,
            'corrected_source_info', NEW.corrected_source_info
        );
    ELSIF v_entity_type = 'scholarship_history' THEN
        v_action := 'created';
        v_entity_id := NEW.history_id;
        v_subject_student_id := NEW.student_id;
        v_subject_fellowship_id := NEW.fellowship_id;
        v_new_values := jsonb_build_object(
            'history_id', NEW.history_id,
            'student_id', NEW.student_id,
            'fellowship_id', NEW.fellowship_id,
            'award_year', NEW.award_year
        );
    ELSIF v_entity_type = 'scholarship_history_amendment' THEN
        v_action := CASE
            WHEN NEW.amendment_type = 'Void' THEN 'voided'
            ELSE 'correction_added'
        END;
        v_entity_id := NEW.amendment_id;
        SELECT b.student_id, b.fellowship_id
          INTO v_subject_student_id, v_subject_fellowship_id
          FROM public.scholarship_history AS b
         WHERE b.history_id = NEW.history_id;
        v_new_values := jsonb_build_object(
            'amendment_id', NEW.amendment_id,
            'history_id', NEW.history_id,
            'amendment_type', NEW.amendment_type,
            'corrected_fellowship_id', NEW.corrected_fellowship_id
        );
    ELSE
        -- Defense in depth: never audit an unattached/future table.
        RETURN NULL;
    END IF;

    INSERT INTO public.audit_event (
        entity_type,
        entity_id,
        action,
        actor_advisor_id,
        actor_name_snapshot,
        old_values,
        new_values,
        changes,
        reason,
        subject_student_id,
        subject_application_id,
        subject_fellowship_id,
        origin
    )
    VALUES (
        v_entity_type,
        v_entity_id,
        v_action,
        v_actor_advisor_id,
        v_actor_name,
        NULL,
        v_new_values,
        NULL,
        NULL,
        v_subject_student_id,
        v_subject_application_id,
        v_subject_fellowship_id,
        v_origin
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.audit_historical_record()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.audit_historical_record() IS
    'Internal SECURITY DEFINER trigger helper: writes exactly one immutable public.audit_event per INSERT of an advising_meeting / fellowship_thursday / scholarship_history base record or its append-only amendment (Void amendments classified voided, other amendments correction_added). Explicit structural snapshots only — narrative notes, amendment reason/details, and any credential/Auth material are structurally excluded; the immutable event_date/award_year base identifiers are recorded on their created events. Same trusted actor-provenance resolution as the current-state audit helpers. Not callable by any client role.';

-- ============================================================================
-- End of migration. Additive columns, two insert boundary guards, appended view
-- columns, and one recreated audit helper only; no existing business row,
-- policy, grant, or audit row is edited, deleted, or reset. Forward-only.
-- ============================================================================
