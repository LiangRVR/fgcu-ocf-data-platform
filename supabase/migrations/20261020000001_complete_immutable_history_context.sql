-- ============================================================================
-- OCF Fellowship Management System — Complete immutable history context
--
-- Forward-only migration ordered AFTER 20261019000001_final_immutable_history_
-- remediation.sql. It completes the immutable audit relationship context that
-- 20261019000001 introduced but deliberately left incomplete:
--
--   1. EVENT-ONLY IDEMPOTENT BACKFILL. `audit_event_subject` is backfilled for
--      every existing `audit_event` using ONLY immutable event columns,
--      snapshots, and diffs. No mutable business table (student/application/
--      fellowship) is joined, no audit event is created, and every insert is
--      `ON CONFLICT DO NOTHING`, so re-applying is duplicate-free.
--
--   2. DETERMINISTIC LABEL PROVENANCE. Historical labels are taken only from
--      the event's immutable payload, with a deterministic side selection:
--      `previous` uses the event-proven OLD value, `current` uses the
--      event-proven NEW value, and `subject` uses an event-time value;
--      otherwise the snapshot is NULL. Application labels are never
--      reconstructed for legacy rows (an application snapshot does not prove a
--      historical fellowship display label). Newly generated events keep their
--      event-time label snapshots untouched.
--
--   3. SEMANTIC SUBJECT CAPTURE. The AFTER subject-capture helper is replaced
--      so application re-links keep both transition endpoints in the one
--      triggering event, and Scholarship History amendments resolve their
--      predecessor from the immutable base/amendment sequence (the same
--      deterministic `(created_at, amendment_id)` order as the effective
--      Scholarship History model), excluding the amendment being written and
--      every later amendment. A Correction writes the immediately prior
--      effective fellowship `previous` and the corrected fellowship `current`; a
--      Void retains the immediately prior effective fellowship `current` and
--      creates no new fellowship. New advising meetings capture the
--      application-time fellowship as `current`; a later advising amendment
--      inherits its fellowship context from the parent meeting's immutable
--      creation audit event and leaves unknown context absent rather than
--      reading the current application row.
--
--   4. DETERMINISTIC REPAIR OF SUPERSEDED DERIVED ROWS. The migration removes
--      only the provably obsolete `audit_event_subject` rows produced by the
--      superseded 20261019000001 helper for affected Scholarship History and
--      advising-amendment events, then inserts the canonical proven set using
--      `ON CONFLICT DO NOTHING` (preserving existing event-time labels). It
--      never modifies or deletes `audit_event`.
--
--   5. TRUSTED BASELINE REVALIDATION. `public.begin_legacy_baseline_import`
--      and the BEFORE normalizer share one trusted service/DBA session check,
--      so a product caller cannot enable baseline mode by a bare GUC. The
--      context stays transaction-local (`set_config(..., true)`).
--
--   6. SAFE RELATIONSHIP READ MODEL. The `security_invoker` `audit_activity`
--      view is extended (columns appended) with explicit relationship-aware
--      scalar snapshots; each reads only `audit_event_subject` snapshot values
--      and preserves NULL. One row per `audit_event` is unchanged.
--
-- Preserved unchanged: `public.audit_event` (immutable; never written here),
-- `audit_event_subject` ACL/RLS (active-advisor SELECT-only), append-only base
-- and amendment records, all existing migrations, and helper hardening
-- (SECURITY DEFINER, `SET search_path = ''`, fully qualified references,
-- EXECUTE revoked from PUBLIC/anon/authenticated). Forward-only; no down
-- migration.
-- ============================================================================


-- ============================================================================
-- 1. Shared trusted baseline-session verification
--
-- A custom GUC is NOT authority: the same trusted technical-session check is
-- invoked both when baseline mode is enabled and when an audit event is
-- normalized, so a product session that sets the GUC by hand cannot forge
-- `baseline_captured` provenance.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.assert_trusted_baseline_session()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_role text;
    v_claim_role text;
BEGIN
    -- The authority is the durable identity, never the caller-set flag alone.
    -- PostgREST v14 sets the request JWT via `request.jwt.claims` (JSON) and no
    -- longer populates the legacy per-claim `request.jwt.claim.role` GUC, so the
    -- request role must be read through `auth.role()` (which coalesces the
    -- legacy GUC with `request.jwt.claims -> 'role'`). Reading the retired GUC
    -- directly returned NULL for a genuine service_role request and made the
    -- trusted entry point fail closed with 42501.
    --
    -- A service-role request must satisfy BOTH durable signals together, so
    -- spoofing either one alone still fails closed:
    --   * `role` is the explicit SET ROLE the request runs under, and — unlike
    --     current_user — it survives SECURITY DEFINER.
    --   * `auth.role()` is the request JWT role.
    -- A product session (anon/authenticated, including an effective App Admin)
    -- carries a product JWT role, so a hand-set `request.jwt.claim.role`, a
    -- hand-set `request.jwt.claims`, or a bare SET ROLE cannot forge this.
    v_role := coalesce(current_setting('role', true), 'none');
    v_claim_role := nullif(auth.role(), '');

    IF v_role = 'service_role' AND v_claim_role = 'service_role' THEN
        RETURN;
    END IF;

    -- Trusted direct DBA/migration session (loopback `postgres`/`supabase_admin`)
    -- that has not SET ROLE into a product role. `role` is checked because it
    -- survives SECURITY DEFINER, unlike current_user.
    IF session_user IN ('postgres', 'supabase_admin')
       AND v_role IN ('none', 'postgres', 'supabase_admin') THEN
        RETURN;
    END IF;

    RAISE EXCEPTION 'legacy baseline context is restricted to trusted technical sessions'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION private.assert_trusted_baseline_session()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.assert_trusted_baseline_session() IS
    'Internal trusted baseline-session verifier. Accepts a PostgREST service-role request only when BOTH the durable `role` GUC (SET ROLE; survives SECURITY DEFINER) and the request JWT role via auth.role() (PostgREST v14 stores the role in request.jwt.claims, not the retired request.jwt.claim.role) equal service_role, and accepts a direct postgres/supabase_admin session that has not SET ROLE into a product role. Raises 42501 otherwise. Shared by public.begin_legacy_baseline_import and the BEFORE baseline normalizer so neither a caller-set flag GUC nor a single spoofed role signal can forge baseline provenance. Not callable by any client role.';


-- ============================================================================
-- 2. Transaction-local trusted baseline import (replaces 20261019000001)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.begin_legacy_baseline_import()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM private.assert_trusted_baseline_session();
    PERFORM pg_catalog.set_config('ocf.legacy_baseline_import', 'on', true);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_legacy_baseline_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_legacy_baseline_import() TO service_role;

COMMENT ON FUNCTION public.begin_legacy_baseline_import() IS
    'Trusted, transaction-local legacy baseline entry point (service_role / postgres / supabase_admin only): validates the trusted session, then enables baseline provenance for the current transaction only. Product sessions cannot execute it and cannot rely on a caller-set GUC.';


-- ============================================================================
-- 3. Baseline normalizer (replaces 20261019000001): revalidated, not GUC-trust
-- ============================================================================
CREATE OR REPLACE FUNCTION private.normalize_baseline_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF coalesce(current_setting('ocf.legacy_baseline_import', true), '') = 'on' THEN
        -- Re-validate: the flag only selects the branch; the trusted session is
        -- the authority. A product session that sets the GUC fails closed here.
        PERFORM private.assert_trusted_baseline_session();
        NEW.action := 'baseline_captured';
        NEW.origin := 'migration';
        NEW.actor_advisor_id := NULL;
        NEW.actor_name_snapshot := 'System';
        NEW.reason := NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.normalize_baseline_audit_event()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_normalize_baseline_audit_event ON public.audit_event;
CREATE TRIGGER trg_normalize_baseline_audit_event
    BEFORE INSERT ON public.audit_event
    FOR EACH ROW EXECUTE FUNCTION private.normalize_baseline_audit_event();


-- ============================================================================
-- 4. Immutable-event label helper (backfill/legacy provenance only)
--
-- Deterministic side selection: `previous` reads the event-proven OLD value,
-- `current` reads the event-proven NEW value, and `subject` reads the
-- event-time (NEW, falling back to OLD) value. When the event payload does not
-- prove a label, the result is NULL. Application labels are never
-- reconstructed for legacy rows.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.audit_event_subject_label(
    p_type text,
    p_relationship text,
    p_old jsonb,
    p_new jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_label text;
BEGIN
    IF p_type = 'student' THEN
        IF p_relationship = 'previous' THEN
            v_label := nullif(p_old ->> 'full_name', '');
        ELSIF p_relationship = 'current' THEN
            v_label := nullif(p_new ->> 'full_name', '');
        ELSE
            v_label := coalesce(nullif(p_new ->> 'full_name', ''), nullif(p_old ->> 'full_name', ''));
        END IF;
    ELSIF p_type = 'fellowship' THEN
        IF p_relationship = 'previous' THEN
            v_label := nullif(p_old ->> 'fellowship_name', '');
        ELSIF p_relationship = 'current' THEN
            v_label := nullif(p_new ->> 'fellowship_name', '');
        ELSE
            v_label := coalesce(nullif(p_new ->> 'fellowship_name', ''), nullif(p_old ->> 'fellowship_name', ''));
        END IF;
    ELSE
        -- Application (and any other type): a legacy snapshot does not prove a
        -- historical display label, so it stays NULL.
        v_label := NULL;
    END IF;
    RETURN v_label;
END;
$$;

REVOKE ALL ON FUNCTION private.audit_event_subject_label(text, text, jsonb, jsonb)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.audit_event_subject_label(text, text, jsonb, jsonb) IS
    'Internal IMMUTABLE label resolver for the event-only backfill: returns a frozen label only from the event''s immutable old_values/new_values with deterministic side selection (previous->old, current->new, subject->event-time), and NULL when the payload does not prove the label. Never consults mutable state; not callable by any client role.';


-- ============================================================================
-- 5. Semantic subject capture (replaces 20261019000001)
--
-- Scholarship History amendment handling precedes generic fellowship handling.
-- The predecessor uses the effective Scholarship History ordering
-- `(created_at, amendment_id) DESC` and excludes the current amendment and
-- every later one.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.capture_audit_event_subjects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_old_student integer := nullif(NEW.changes -> 'student_id' ->> 'old', '')::integer;
    v_old_fellowship integer := nullif(NEW.changes -> 'fellowship_id' ->> 'old', '')::integer;
    v_corrected_fellowship integer := nullif(NEW.new_values ->> 'corrected_fellowship_id', '')::integer;
    v_meeting_fellowship integer;
    v_history_id integer;
    v_amendment_created_at timestamptz;
    v_amendment_id integer;
    v_prior_fellowship integer;
    v_meeting_id integer;
    v_parent_fellowship integer;
    v_parent_fellowship_label text;
    v_parent_application integer;
    v_parent_application_label text;
BEGIN
    -- 1. Direct entity/subject context from the immutable event columns.
    --    The canonical subject columns remain current-context compatibility.
    IF NEW.subject_student_id IS NOT NULL THEN
        INSERT INTO public.audit_event_subject VALUES (
            NEW.audit_id, 'student', NEW.subject_student_id,
            CASE WHEN NEW.entity_type = 'student' THEN 'subject' ELSE 'current' END,
            private.audit_subject_label('student', NEW.subject_student_id)
        ) ON CONFLICT DO NOTHING;
    END IF;
    -- A Scholarship History amendment resolves its fellowship context below
    -- (previous/corrected/void-aware); an advising amendment inherits its
    -- application label from the parent meeting below. Neither emits the
    -- generic current-state row.
    IF NEW.subject_application_id IS NOT NULL
       AND NEW.entity_type <> 'advising_meeting_amendment' THEN
        INSERT INTO public.audit_event_subject VALUES (
            NEW.audit_id, 'application', NEW.subject_application_id, 'subject',
            private.audit_subject_label('application', NEW.subject_application_id)
        ) ON CONFLICT DO NOTHING;
    END IF;
    -- A Scholarship History amendment resolves its fellowship context below
    -- (previous/corrected/void-aware); never emit the base award generically.
    IF NEW.subject_fellowship_id IS NOT NULL
       AND NEW.entity_type <> 'scholarship_history_amendment' THEN
        INSERT INTO public.audit_event_subject VALUES (
            NEW.audit_id, 'fellowship', NEW.subject_fellowship_id,
            CASE WHEN NEW.entity_type = 'fellowship' THEN 'subject' ELSE 'current' END,
            private.audit_subject_label('fellowship', NEW.subject_fellowship_id)
        ) ON CONFLICT DO NOTHING;
    END IF;

    -- 2. Application re-link: one event carries the application subject and
    --    both the old (`previous`) and new (`current`) endpoints.
    IF NEW.entity_type = 'application' THEN
        IF v_old_student IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (
                NEW.audit_id, 'student', v_old_student, 'previous',
                private.audit_subject_label('student', v_old_student)
            ) ON CONFLICT DO NOTHING;
        END IF;
        IF v_old_fellowship IS NOT NULL THEN
            INSERT INTO public.audit_event_subject VALUES (
                NEW.audit_id, 'fellowship', v_old_fellowship, 'previous',
                private.audit_subject_label('fellowship', v_old_fellowship)
            ) ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- 3. Scholarship History amendment: deterministic predecessor.
    IF NEW.entity_type = 'scholarship_history_amendment' THEN
        v_history_id := nullif(NEW.new_values ->> 'history_id', '')::integer;

        SELECT a.created_at, a.amendment_id
          INTO v_amendment_created_at, v_amendment_id
          FROM public.scholarship_history_amendment AS a
         WHERE a.amendment_id = NEW.entity_id;

        v_prior_fellowship := NULL;
        IF v_history_id IS NOT NULL AND v_amendment_created_at IS NOT NULL THEN
            -- Latest preceding Correction still effective immediately before
            -- this amendment (strictly earlier in the canonical order).
            SELECT c.corrected_fellowship_id
              INTO v_prior_fellowship
              FROM public.scholarship_history_amendment AS c
             WHERE c.history_id = v_history_id
               AND c.amendment_type = 'Correction'
               AND c.corrected_fellowship_id IS NOT NULL
               AND (c.created_at, c.amendment_id) < (v_amendment_created_at, v_amendment_id)
             ORDER BY c.created_at DESC, c.amendment_id DESC
             LIMIT 1;

            IF NOT FOUND THEN
                SELECT b.fellowship_id
                  INTO v_prior_fellowship
                  FROM public.scholarship_history AS b
                 WHERE b.history_id = v_history_id;
            END IF;
        END IF;

        IF NEW.action = 'voided' THEN
            -- A Void retains the immediately prior effective fellowship as
            -- current historical context and creates no new fellowship.
            IF v_prior_fellowship IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'fellowship', v_prior_fellowship, 'current',
                    private.audit_subject_label('fellowship', v_prior_fellowship)
                ) ON CONFLICT DO NOTHING;
            END IF;
        ELSE
            IF v_prior_fellowship IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'fellowship', v_prior_fellowship, 'previous',
                    private.audit_subject_label('fellowship', v_prior_fellowship)
                ) ON CONFLICT DO NOTHING;
            END IF;
            IF v_corrected_fellowship IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'fellowship', v_corrected_fellowship, 'current',
                    private.audit_subject_label('fellowship', v_corrected_fellowship)
                ) ON CONFLICT DO NOTHING;
            END IF;
        END IF;
    END IF;

    -- 4. Advising fellowship context.
    IF NEW.entity_type = 'advising_meeting' THEN
        -- A new meeting resolves the application-time fellowship within the
        -- source transaction (never used for legacy backfill).
        IF NEW.subject_application_id IS NOT NULL THEN
            SELECT a.fellowship_id
              INTO v_meeting_fellowship
              FROM public.application AS a
             WHERE a.application_id = NEW.subject_application_id;
            IF v_meeting_fellowship IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'fellowship', v_meeting_fellowship, 'current',
                    private.audit_subject_label('fellowship', v_meeting_fellowship)
                ) ON CONFLICT DO NOTHING;
            END IF;
        END IF;
    ELSIF NEW.entity_type = 'advising_meeting_amendment' THEN
        -- Inherit application/fellowship context from the parent meeting's
        -- immutable creation audit event; never read current mutable
        -- application state. Unknown inherited context stays absent.
        v_meeting_id := nullif(NEW.new_values ->> 'meeting_id', '')::integer;
        IF v_meeting_id IS NOT NULL THEN
            SELECT aes.subject_id, aes.subject_name_snapshot
              INTO v_parent_fellowship, v_parent_fellowship_label
              FROM public.audit_event AS pae
              JOIN public.audit_event_subject AS aes
                ON aes.audit_id = pae.audit_id
               AND aes.subject_type = 'fellowship'
             WHERE pae.entity_type = 'advising_meeting'
               AND pae.entity_id = v_meeting_id
               AND pae.action = 'created'
             ORDER BY pae.audit_id, aes.relationship, aes.subject_id
             LIMIT 1;

            IF v_parent_fellowship IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'fellowship', v_parent_fellowship, 'current',
                    v_parent_fellowship_label
                ) ON CONFLICT DO NOTHING;
            END IF;

            SELECT aes.subject_id, aes.subject_name_snapshot
              INTO v_parent_application, v_parent_application_label
              FROM public.audit_event AS pae
              JOIN public.audit_event_subject AS aes
                ON aes.audit_id = pae.audit_id
               AND aes.subject_type = 'application'
             WHERE pae.entity_type = 'advising_meeting'
               AND pae.entity_id = v_meeting_id
               AND pae.action = 'created'
             ORDER BY pae.audit_id, aes.relationship, aes.subject_id
             LIMIT 1;

            IF v_parent_application IS NOT NULL THEN
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'application', v_parent_application, 'subject',
                    v_parent_application_label
                ) ON CONFLICT DO NOTHING;
            ELSIF NEW.subject_application_id IS NOT NULL THEN
                -- Immutable meeting-row link with an unknown historical label.
                INSERT INTO public.audit_event_subject VALUES (
                    NEW.audit_id, 'application', NEW.subject_application_id, 'subject', NULL
                ) ON CONFLICT DO NOTHING;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.capture_audit_event_subjects()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_capture_audit_event_subjects ON public.audit_event;
CREATE TRIGGER trg_capture_audit_event_subjects
    AFTER INSERT ON public.audit_event
    FOR EACH ROW EXECUTE FUNCTION private.capture_audit_event_subjects();

COMMENT ON FUNCTION private.capture_audit_event_subjects() IS
    'Internal SECURITY DEFINER AFTER-INSERT audit helper: writes canonical audit_event_subject associations for a new event. Entity/action aware: direct subject columns use subject/current; application re-links keep both previous and current endpoints in one event; Scholarship History Corrections use the immediately prior effective fellowship (deterministic (created_at, amendment_id) order, excluding the current and later amendments) as previous and the corrected fellowship as current; Voids retain the prior effective fellowship as current; new advising meetings capture application-time fellowship while amendments inherit the parent meeting''s immutable creation context (unknown stays absent). Not callable by any client role.';


-- ============================================================================
-- 6. Event-only idempotent backfill + targeted derived-row repair
--
-- Reads ONLY `audit_event` (plus, for the narrow repair, immutable
-- base/amendment and parent-event evidence). Joins no mutable business table,
-- creates no audit event, and never modifies/deletes `audit_event`.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.backfill_audit_event_subjects()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- 6a. Direct entity/subject associations from immutable event columns.
    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT ae.audit_id, 'student', ae.subject_student_id,
           CASE WHEN ae.entity_type = 'student' THEN 'subject' ELSE 'current' END,
           private.audit_event_subject_label(
               'student',
               CASE WHEN ae.entity_type = 'student' THEN 'subject' ELSE 'current' END,
               ae.old_values, ae.new_values)
      FROM public.audit_event AS ae
     WHERE ae.subject_student_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT ae.audit_id, 'application', ae.subject_application_id, 'subject',
           private.audit_event_subject_label('application', 'subject', ae.old_values, ae.new_values)
      FROM public.audit_event AS ae
     WHERE ae.subject_application_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- Scholarship History amendments are reconciled in 6d (semantic set).
    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT ae.audit_id, 'fellowship', ae.subject_fellowship_id,
           CASE WHEN ae.entity_type = 'fellowship' THEN 'subject' ELSE 'current' END,
           private.audit_event_subject_label(
               'fellowship',
               CASE WHEN ae.entity_type = 'fellowship' THEN 'subject' ELSE 'current' END,
               ae.old_values, ae.new_values)
      FROM public.audit_event AS ae
     WHERE ae.subject_fellowship_id IS NOT NULL
       AND ae.entity_type <> 'scholarship_history_amendment'
    ON CONFLICT DO NOTHING;

    -- 6b. Application transition prior endpoints (immutable diff only).
    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT ae.audit_id, 'student', nullif(ae.changes -> 'student_id' ->> 'old', '')::integer, 'previous',
           private.audit_event_subject_label('student', 'previous', ae.old_values, ae.new_values)
      FROM public.audit_event AS ae
     WHERE ae.entity_type = 'application'
       AND nullif(ae.changes -> 'student_id' ->> 'old', '') IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT ae.audit_id, 'fellowship', nullif(ae.changes -> 'fellowship_id' ->> 'old', '')::integer, 'previous',
           private.audit_event_subject_label('fellowship', 'previous', ae.old_values, ae.new_values)
      FROM public.audit_event AS ae
     WHERE ae.entity_type = 'application'
       AND nullif(ae.changes -> 'fellowship_id' ->> 'old', '') IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- 6c. Recomputed canonical fellowship sets for the narrowly affected
    --     post-20261019000001 derived rows. Only the (subject_id, relationship)
    --     pairs the superseded 20261019000001 helper could actually have emitted
    --     are eligible for removal, and only when immutable evidence proves them
    --     obsolete: for a Scholarship History amendment the immutable base award
    --     (the event's subject_fellowship_id) as current/previous and the
    --     recorded corrected fellowship as current; for an advising amendment the
    --     sole mutable-application-derived current row (its subject_fellowship_id
    --     is always NULL for that entity). A known canonical/frozen row that is
    --     not such a provable artifact is never deleted; the INSERT restores the
    --     proven set and preserves existing labels.
    WITH scholar AS (
        SELECT am.audit_id, am.prior_fellowship AS subject_id,
               CASE WHEN am.action = 'voided' THEN 'current' ELSE 'previous' END AS relationship,
               NULL::text AS subject_name_snapshot
          FROM (
              SELECT ae.audit_id, ae.action, a.history_id, a.created_at, a.amendment_id,
                     coalesce(
                         (SELECT c.corrected_fellowship_id
                            FROM public.scholarship_history_amendment AS c
                           WHERE c.history_id = a.history_id
                             AND c.amendment_type = 'Correction'
                             AND c.corrected_fellowship_id IS NOT NULL
                             AND (c.created_at, c.amendment_id) < (a.created_at, a.amendment_id)
                           ORDER BY c.created_at DESC, c.amendment_id DESC
                           LIMIT 1),
                         (SELECT b.fellowship_id
                            FROM public.scholarship_history AS b
                           WHERE b.history_id = a.history_id)
                     ) AS prior_fellowship
                FROM public.audit_event AS ae
                JOIN public.scholarship_history_amendment AS a
                  ON a.amendment_id = ae.entity_id
               WHERE ae.entity_type = 'scholarship_history_amendment'
          ) AS am
         WHERE am.prior_fellowship IS NOT NULL
        UNION ALL
        SELECT ae.audit_id, a.corrected_fellowship_id, 'current', NULL::text
          FROM public.audit_event AS ae
          JOIN public.scholarship_history_amendment AS a
            ON a.amendment_id = ae.entity_id
         WHERE ae.entity_type = 'scholarship_history_amendment'
           AND ae.action <> 'voided'
           AND a.corrected_fellowship_id IS NOT NULL
    ),
    advising AS (
        SELECT DISTINCT ON (ae.audit_id)
               ae.audit_id, aes.subject_id, 'current'::text AS relationship,
               aes.subject_name_snapshot
          FROM public.audit_event AS ae
          JOIN public.audit_event AS pae
            ON pae.entity_type = 'advising_meeting'
           AND pae.entity_id = nullif(ae.new_values ->> 'meeting_id', '')::integer
           AND pae.action = 'created'
          JOIN public.audit_event_subject AS aes
            ON aes.audit_id = pae.audit_id
           AND aes.subject_type = 'fellowship'
           AND aes.relationship = 'current'
         WHERE ae.entity_type = 'advising_meeting_amendment'
           AND nullif(ae.new_values ->> 'meeting_id', '') IS NOT NULL
         ORDER BY ae.audit_id, aes.subject_id
    ),
    canonical AS (
        SELECT DISTINCT audit_id, subject_id, relationship, subject_name_snapshot FROM scholar
        UNION ALL
        SELECT DISTINCT audit_id, subject_id, relationship, subject_name_snapshot FROM advising
    ),
    removed AS (
        DELETE FROM public.audit_event_subject AS aes
         USING public.audit_event AS ae
         WHERE aes.audit_id = ae.audit_id
           AND aes.subject_type = 'fellowship'
           AND (
               (
                   ae.entity_type = 'scholarship_history_amendment'
                   AND (
                       (aes.subject_id = ae.subject_fellowship_id
                        AND aes.relationship = 'current')
                       OR (aes.subject_id = ae.subject_fellowship_id
                           AND aes.relationship = 'previous'
                           AND nullif(ae.new_values ->> 'corrected_fellowship_id', '') IS NOT NULL)
                       OR (aes.subject_id = nullif(ae.new_values ->> 'corrected_fellowship_id', '')::integer
                           AND aes.relationship = 'current')
                   )
               )
               OR (
                   ae.entity_type = 'advising_meeting_amendment'
                   AND aes.relationship = 'current'
               )
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM canonical AS c
                WHERE c.audit_id = aes.audit_id
                  AND c.subject_id = aes.subject_id
                  AND c.relationship = aes.relationship
           )
        RETURNING 1
    )
    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT c.audit_id, 'fellowship', c.subject_id, c.relationship, c.subject_name_snapshot
      FROM canonical AS c
    ON CONFLICT DO NOTHING;

    -- 6c. Advising-amendment APPLICATION context. A later amendment inherits
    --     its application association AND its frozen label from the parent
    --     meeting's immutable creation audit event (falling back to the
    --     amendment event's own immutable meeting link with an unknown label).
    --     The ONLY application association the superseded helper could write for
    --     an amendment is its own direct link (subject_id = the immutable event
    --     subject_application_id, relationship 'subject') carrying a
    --     current-mutable label. Only that provable artifact is removed, and only
    --     when it differs from the canonical parent association/label, so a
    --     known canonical/frozen row is preserved and a conflict-suppressed
    --     insert could not leave a stale mutable label. Unknown stays absent. No
    --     mutable application lookup is performed.
    DELETE FROM public.audit_event_subject AS aes
     USING public.audit_event AS ae
           LEFT JOIN LATERAL (
               SELECT pas.subject_id, pas.subject_name_snapshot
                 FROM public.audit_event AS pae
                 JOIN public.audit_event_subject AS pas
                   ON pas.audit_id = pae.audit_id
                  AND pas.subject_type = 'application'
                WHERE pae.entity_type = 'advising_meeting'
                  AND pae.entity_id = nullif(ae.new_values ->> 'meeting_id', '')::integer
                  AND pae.action = 'created'
                ORDER BY pae.audit_id, pas.relationship, pas.subject_id
                LIMIT 1
           ) AS pap ON true
     WHERE aes.audit_id = ae.audit_id
       AND ae.entity_type = 'advising_meeting_amendment'
       AND aes.subject_type = 'application'
       AND aes.relationship = 'subject'
       -- Provable superseded-helper artifact: its own direct meeting link.
       AND aes.subject_id = ae.subject_application_id
       -- Remove only when the parent's immutable context supersedes it.
       AND (coalesce(pap.subject_id, ae.subject_application_id) IS DISTINCT FROM ae.subject_application_id
            OR aes.subject_name_snapshot IS DISTINCT FROM pap.subject_name_snapshot);

    INSERT INTO public.audit_event_subject
        (audit_id, subject_type, subject_id, relationship, subject_name_snapshot)
    SELECT DISTINCT ON (ae.audit_id)
           ae.audit_id, 'application',
           coalesce(pap.subject_id, ae.subject_application_id), 'subject',
           pap.subject_name_snapshot
      FROM public.audit_event AS ae
      LEFT JOIN LATERAL (
          SELECT pas.subject_id, pas.subject_name_snapshot
            FROM public.audit_event AS pae
            JOIN public.audit_event_subject AS pas
              ON pas.audit_id = pae.audit_id
             AND pas.subject_type = 'application'
           WHERE pae.entity_type = 'advising_meeting'
             AND pae.entity_id = nullif(ae.new_values ->> 'meeting_id', '')::integer
             AND pae.action = 'created'
           ORDER BY pae.audit_id, pas.relationship, pas.subject_id
           LIMIT 1
      ) AS pap ON true
     WHERE ae.entity_type = 'advising_meeting_amendment'
       AND coalesce(pap.subject_id, ae.subject_application_id) IS NOT NULL
     ORDER BY ae.audit_id
    ON CONFLICT DO NOTHING;

    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION private.backfill_audit_event_subjects()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.backfill_audit_event_subjects() IS
    'Internal idempotent event-only backfill: derives canonical audit_event_subject associations for existing audit events from immutable columns/snapshots/diffs only (no mutable joins, no audit event created), and deterministically repairs only the provable superseded-helper derived rows for scholarship_history_amendment (fellowship context) and advising_meeting_amendment (application and fellowship context inherited from the parent meeting''s immutable creation audit event, including frozen labels) without touching audit_event. Removal is scoped to the exact (subject_id, relationship) artifacts the superseded 20261019000001 helper could emit; a known canonical/frozen association that is not such an artifact is preserved, and unknown inherited fellowship context is left absent. Safe to invoke more than once; not callable by any client role.';

-- Apply the backfill now (idempotent; conflict-suppressed).
SELECT private.backfill_audit_event_subjects();


-- ============================================================================
-- 7. audit_event_subject ACL/RLS restated (active-advisor SELECT-only)
-- ============================================================================
ALTER TABLE public.audit_event_subject ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_event_subject FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_event_subject TO authenticated;

DROP POLICY IF EXISTS audit_event_subject_select_active_advisor ON public.audit_event_subject;
CREATE POLICY audit_event_subject_select_active_advisor ON public.audit_event_subject
    FOR SELECT TO authenticated USING (public.is_active_advisor());


-- ============================================================================
-- 8. Safe relationship-aware read model
--
-- CREATE OR REPLACE VIEW only APPENDS the new scalars after the existing
-- columns, preserving `security_invoker = on`, one row per audit event, and the
-- existing membership arrays. Each scalar reads only frozen subject snapshots
-- and stays NULL when no immutable label is proven.
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
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'))::character varying AS student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'))::character varying AS fellowship_name,
    ARRAY(SELECT aes.subject_id FROM public.audit_event_subject AS aes
           WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
           ORDER BY aes.subject_id, aes.relationship) AS student_subject_ids,
    ARRAY(SELECT aes.subject_id FROM public.audit_event_subject AS aes
           WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
           ORDER BY aes.subject_id, aes.relationship) AS fellowship_subject_ids,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
         AND aes.relationship = 'previous'))::character varying AS previous_student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
         AND aes.relationship = 'current'))::character varying AS current_student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
         AND aes.relationship = 'previous'))::character varying AS previous_fellowship_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
         AND aes.relationship = 'current'))::character varying AS current_fellowship_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'application'
         AND aes.relationship = 'subject'))::character varying AS subject_application_name
  FROM public.audit_event AS ae;

COMMENT ON VIEW public.audit_activity IS
    'Explicit-column, read-only, SECURITY INVOKER audit activity read model. Exposes only audit-safe event fields plus relationship-aware labels resolved from frozen audit_event_subject snapshots (previous/current student and fellowship, subject application) and association-ID membership arrays; the actor context is the frozen actor_name_snapshot (never a live advisor join) and no Auth-binding/private column is exposed. One row per audit_event; remains governed by the underlying active-advisor audit RLS.';

REVOKE ALL ON public.audit_activity FROM anon, authenticated;
GRANT SELECT ON public.audit_activity TO authenticated;

-- ============================================================================
-- End of migration. Forward-only; `audit_event` is never written here and no
-- existing migration, policy, or grant is removed.
-- ============================================================================
