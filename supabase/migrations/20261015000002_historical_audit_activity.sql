-- ============================================================================
-- OCF Fellowship Management System — Historical audit + activity read view
--
-- Forward-only, additive migration for the approved
-- `historical-audit-timeline` design (AI-DLC, Plan Work 2). It extends the
-- existing immutable-audit core to the historical base/amendment records and
-- adds the safe read model for the global activity log:
--
--   1. one internal SECURITY DEFINER trigger helper
--      (`private.audit_historical_record`) with explicit structural snapshots
--      and the SAME trusted actor-provenance logic as the existing audit
--      helpers. It is attached AFTER INSERT to:
--        * `advising_meeting`                -> `created`
--        * `advising_meeting_amendment`      -> `correction_added`
--        * `fellowship_thursday`             -> `created`
--        * `fellowship_thursday_amendment`   -> `correction_added`
--        * `scholarship_history`             -> `created`
--        * `scholarship_history_amendment`   -> `correction_added`
--                                             (a Void -> `voided`)
--      Every helper creates exactly one event in the source transaction and
--      emits only whitelisted identifiers/structural context: narrative
--      `notes`, amendment `reason`/`details`, credentials, Auth claims,
--      tokens, and passwords never enter a payload. No historical row is
--      backfilled.
--   2. one explicit-column `security_invoker` activity view
--      (`public.audit_activity`) that selects only audit-safe event fields and
--      display-safe current context (student/fellowship labels) with
--      `actor_name_snapshot` rather than current advisor joins, and no
--      Auth-binding columns. It is SELECT-only, granted to `authenticated`
--      only, and remains governed by the underlying active-advisor audit RLS.
--
-- The reserved `audit_event` entity/action vocabulary already covers every
-- value written here, and the existing chronology indexes already serve the
-- documented access paths, so no vocabulary/CHECK/index change is required
-- (NFR2: no speculative index is added).
--
-- Preserved unchanged: immutable `audit_event` ACL/RLS, append-only amendment
-- behavior, effective correction/Void semantics, lifecycle/role guards, and
-- all current-state writer contracts. Forward-only; no existing business row
-- is edited, deleted, or reset.
-- ============================================================================


-- ============================================================================
-- 1. Internal historical audit trigger helper
--
-- SECURITY DEFINER, `SET search_path = ''`, fully qualified references. It is
-- invoked ONLY by the AFTER INSERT triggers below (a trigger mechanism needs no
-- EXECUTE grant); no client role has EXECUTE.
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
            'source_info', NEW.source_info
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
            'fellowship_id', NEW.fellowship_id
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
    'Internal SECURITY DEFINER trigger helper: writes exactly one immutable public.audit_event per INSERT of an advising_meeting / fellowship_thursday / scholarship_history base record or its append-only amendment (Void amendments classified voided, other amendments correction_added). Explicit structural snapshots only — narrative notes, amendment reason/details, and any credential/Auth material are structurally excluded. Same trusted actor-provenance resolution as the current-state audit helpers. Not callable by any client role.';


-- ============================================================================
-- 2. AFTER INSERT triggers on the historical base/amendment tables
-- ============================================================================
DROP TRIGGER IF EXISTS trg_audit_advising_meeting_created ON public.advising_meeting;
CREATE TRIGGER trg_audit_advising_meeting_created
    AFTER INSERT ON public.advising_meeting
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();

DROP TRIGGER IF EXISTS trg_audit_advising_meeting_amendment_created ON public.advising_meeting_amendment;
CREATE TRIGGER trg_audit_advising_meeting_amendment_created
    AFTER INSERT ON public.advising_meeting_amendment
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();

DROP TRIGGER IF EXISTS trg_audit_fellowship_thursday_created ON public.fellowship_thursday;
CREATE TRIGGER trg_audit_fellowship_thursday_created
    AFTER INSERT ON public.fellowship_thursday
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();

DROP TRIGGER IF EXISTS trg_audit_fellowship_thursday_amendment_created ON public.fellowship_thursday_amendment;
CREATE TRIGGER trg_audit_fellowship_thursday_amendment_created
    AFTER INSERT ON public.fellowship_thursday_amendment
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();

DROP TRIGGER IF EXISTS trg_audit_scholarship_history_created ON public.scholarship_history;
CREATE TRIGGER trg_audit_scholarship_history_created
    AFTER INSERT ON public.scholarship_history
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();

DROP TRIGGER IF EXISTS trg_audit_scholarship_history_amendment_created ON public.scholarship_history_amendment;
CREATE TRIGGER trg_audit_scholarship_history_amendment_created
    AFTER INSERT ON public.scholarship_history_amendment
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_historical_record();


-- ============================================================================
-- 3. Safe activity read view
--
-- Explicit columns only; no Auth-binding/private fields. Context labels are
-- resolved by correlated scalar subqueries over unique keys (no row
-- multiplication). SECURITY INVOKER so the underlying active-advisor audit RLS
-- (and the student/fellowship RLS on the label lookups) still applies.
-- ============================================================================
CREATE OR REPLACE VIEW public.audit_activity
WITH (security_invoker = on)
AS
SELECT
    ae.audit_id,
    ae.occurred_at,
    ae.entity_type,
    ae.entity_id,
    ae.action,
    ae.actor_advisor_id,
    ae.actor_name_snapshot,
    ae.reason,
    ae.origin,
    ae.old_values,
    ae.new_values,
    ae.changes,
    ae.subject_student_id,
    ae.subject_application_id,
    ae.subject_fellowship_id,
    (
        SELECT s.full_name
          FROM public.student AS s
         WHERE s.student_id = ae.subject_student_id
    ) AS student_name,
    (
        SELECT f.fellowship_name
          FROM public.fellowship AS f
         WHERE f.fellowship_id = ae.subject_fellowship_id
    ) AS fellowship_name
FROM public.audit_event AS ae;

COMMENT ON VIEW public.audit_activity IS
    'Explicit-column, read-only, SECURITY INVOKER audit activity read model for the global activity log and entity detail histories. Exposes only audit-safe event fields plus display-safe student/fellowship labels resolved by correlated scalar subqueries; actor context is the frozen actor_name_snapshot (never a current advisor join) and no Auth-binding/private column is exposed. Remains governed by the underlying active-advisor audit RLS.';

REVOKE ALL ON public.audit_activity FROM anon, authenticated;
GRANT SELECT ON public.audit_activity TO authenticated;

-- ============================================================================
-- End of migration. Additive triggers + view only; no existing business row,
-- policy, grant, or audit row is edited, deleted, or reset. Forward-only.
-- ============================================================================
