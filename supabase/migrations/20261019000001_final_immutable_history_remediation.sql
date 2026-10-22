-- Final immutable-history remediation. Forward-only; no legacy rows are
-- fabricated or backfilled because their former relationships/labels are unknown.

CREATE TABLE public.audit_event_subject (
    audit_id bigint NOT NULL,
    subject_type text NOT NULL,
    subject_id integer NOT NULL,
    relationship text NOT NULL,
    subject_name_snapshot text,
    CONSTRAINT audit_event_subject_pkey PRIMARY KEY (audit_id, subject_type, subject_id, relationship),
    CONSTRAINT audit_event_subject_audit_id_fkey
        FOREIGN KEY (audit_id) REFERENCES public.audit_event(audit_id) ON DELETE NO ACTION,
    CONSTRAINT audit_event_subject_type_check
        CHECK (subject_type IN ('student', 'application', 'fellowship')),
    CONSTRAINT audit_event_subject_relationship_check
        CHECK (relationship IN ('subject', 'previous', 'current'))
);

ALTER TABLE public.audit_event_subject ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_event_subject FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_event_subject TO authenticated;
CREATE POLICY audit_event_subject_select_active_advisor ON public.audit_event_subject
    FOR SELECT TO authenticated USING (public.is_active_advisor());
CREATE INDEX idx_audit_event_subject_lookup
    ON public.audit_event_subject (subject_type, subject_id, audit_id DESC);

CREATE OR REPLACE FUNCTION private.audit_subject_label(p_type text, p_id integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_label text;
BEGIN
    IF p_id IS NULL THEN RETURN NULL; END IF;
    IF p_type = 'student' THEN
        SELECT s.full_name INTO v_label FROM public.student s WHERE s.student_id = p_id;
    ELSIF p_type = 'fellowship' THEN
        SELECT f.fellowship_name INTO v_label FROM public.fellowship f WHERE f.fellowship_id = p_id;
    ELSIF p_type = 'application' THEN
        SELECT concat_ws(' — ', f.fellowship_name, a.application_year::text)
          INTO v_label FROM public.application a JOIN public.fellowship f ON f.fellowship_id = a.fellowship_id
         WHERE a.application_id = p_id;
    END IF;
    RETURN v_label;
END;
$$;
REVOKE ALL ON FUNCTION private.audit_subject_label(text, integer) FROM PUBLIC, anon, authenticated;

-- Trusted import setup is transaction-local. Product sessions cannot execute it;
-- production import SQL must call this helper in the same transaction as inserts.
CREATE OR REPLACE FUNCTION public.begin_legacy_baseline_import()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
       AND session_user NOT IN ('postgres', 'supabase_admin') THEN
        RAISE EXCEPTION 'legacy baseline context is restricted to trusted technical sessions'
            USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config('ocf.legacy_baseline_import', 'on', true);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_legacy_baseline_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_legacy_baseline_import() TO service_role;

CREATE OR REPLACE FUNCTION private.normalize_baseline_audit_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF coalesce(current_setting('ocf.legacy_baseline_import', true), '') = 'on' THEN
        NEW.action := 'baseline_captured';
        NEW.origin := 'migration';
        NEW.actor_advisor_id := NULL;
        NEW.actor_name_snapshot := 'System';
        NEW.reason := NULL;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.normalize_baseline_audit_event() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_normalize_baseline_audit_event ON public.audit_event;
CREATE TRIGGER trg_normalize_baseline_audit_event
    BEFORE INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION private.normalize_baseline_audit_event();

CREATE OR REPLACE FUNCTION private.capture_audit_event_subjects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_old_student integer := nullif(NEW.changes -> 'student_id' ->> 'old', '')::integer;
    v_old_fellowship integer := nullif(NEW.changes -> 'fellowship_id' ->> 'old', '')::integer;
    v_corrected_fellowship integer := nullif(NEW.new_values ->> 'corrected_fellowship_id', '')::integer;
    v_meeting_fellowship integer;
BEGIN
    -- The canonical direct fields remain current-context compatibility columns.
    IF NEW.subject_student_id IS NOT NULL THEN
        INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'student', NEW.subject_student_id,
          CASE WHEN NEW.entity_type = 'student' THEN 'subject' ELSE 'current' END,
          private.audit_subject_label('student', NEW.subject_student_id)) ON CONFLICT DO NOTHING;
    END IF;
    IF NEW.subject_application_id IS NOT NULL THEN
        INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'application', NEW.subject_application_id, 'subject',
          private.audit_subject_label('application', NEW.subject_application_id)) ON CONFLICT DO NOTHING;
    END IF;
    IF NEW.subject_fellowship_id IS NOT NULL THEN
        INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'fellowship', NEW.subject_fellowship_id,
          CASE WHEN NEW.entity_type = 'fellowship' THEN 'subject' ELSE 'current' END,
          private.audit_subject_label('fellowship', NEW.subject_fellowship_id)) ON CONFLICT DO NOTHING;
    END IF;
    IF NEW.entity_type = 'application' THEN
        IF v_old_student IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'student', v_old_student, 'previous',
              private.audit_subject_label('student', v_old_student)) ON CONFLICT DO NOTHING;
        END IF;
        IF v_old_fellowship IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'fellowship', v_old_fellowship, 'previous',
              private.audit_subject_label('fellowship', v_old_fellowship)) ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    IF NEW.entity_type = 'scholarship_history_amendment' AND v_corrected_fellowship IS NOT NULL THEN
        IF NEW.subject_fellowship_id IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'fellowship', NEW.subject_fellowship_id, 'previous',
              private.audit_subject_label('fellowship', NEW.subject_fellowship_id)) ON CONFLICT DO NOTHING;
        END IF;
        INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'fellowship', v_corrected_fellowship, 'current',
          private.audit_subject_label('fellowship', v_corrected_fellowship)) ON CONFLICT DO NOTHING;
    END IF;
    -- Advising reaches fellowship only through its optional application.
    IF NEW.entity_type IN ('advising_meeting', 'advising_meeting_amendment') AND NEW.subject_application_id IS NOT NULL THEN
        SELECT a.fellowship_id INTO v_meeting_fellowship FROM public.application a
         WHERE a.application_id = NEW.subject_application_id;
        IF v_meeting_fellowship IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (NEW.audit_id, 'fellowship', v_meeting_fellowship, 'current',
              private.audit_subject_label('fellowship', v_meeting_fellowship)) ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.capture_audit_event_subjects() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_capture_audit_event_subjects ON public.audit_event;
CREATE TRIGGER trg_capture_audit_event_subjects
    AFTER INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION private.capture_audit_event_subjects();

-- Archive state is a database rule, not an affordance. Lifecycle archive/restore
-- changes archived_at and therefore deliberately passes this guard.
CREATE OR REPLACE FUNCTION private.reject_archived_current_state_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
       AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'archived records are read-only; restore before editing' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.reject_archived_current_state_mutation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_student_archived_read_only ON public.student;
CREATE TRIGGER trg_student_archived_read_only BEFORE UPDATE ON public.student
    FOR EACH ROW EXECUTE FUNCTION private.reject_archived_current_state_mutation();
DROP TRIGGER IF EXISTS trg_fellowship_archived_read_only ON public.fellowship;
CREATE TRIGGER trg_fellowship_archived_read_only BEFORE UPDATE ON public.fellowship
    FOR EACH ROW EXECUTE FUNCTION private.reject_archived_current_state_mutation();

CREATE OR REPLACE VIEW public.audit_activity WITH (security_invoker = on) AS
SELECT ae.audit_id, ae.occurred_at, ae.entity_type, ae.entity_id, ae.action,
       ae.actor_advisor_id, ae.actor_name_snapshot, ae.reason, ae.origin,
       ae.old_values, ae.new_values, ae.changes,
       ae.subject_student_id, ae.subject_application_id, ae.subject_fellowship_id,
       ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
          FROM public.audit_event_subject aes WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'))::character varying AS student_name,
       ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
          FROM public.audit_event_subject aes WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'))::character varying AS fellowship_name,
       ARRAY(SELECT aes.subject_id FROM public.audit_event_subject aes WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student') AS student_subject_ids,
       ARRAY(SELECT aes.subject_id FROM public.audit_event_subject aes WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship') AS fellowship_subject_ids
  FROM public.audit_event ae;
REVOKE ALL ON public.audit_activity FROM anon, authenticated;
GRANT SELECT ON public.audit_activity TO authenticated;
