-- ============================================================================
-- OCF Fellowship Management System — Immutable current-state audit trail
--
-- Forward-only, additive migration for the approved `immutable-audit-trail`
-- design (AI-DLC, Work 1–5). It creates the immutable, row-level-security-
-- protected `public.audit_event` read model and attaches one unexposed
-- `SECURITY DEFINER` trigger helper to the three current-state business
-- tables (student, fellowship, application) so that every INSERT and every
-- meaningful UPDATE writes exactly one database-authored, transaction-atomic
-- audit event inside the source mutation's own transaction. An audit
-- failure aborts the business write; no client code or RPC can fabricate
-- history.
--
-- Table contract (public.audit_event):
--   * audit_id           bigint PRIMARY KEY (sequence-backed; no client usage);
--   * entity_type        text CHECK — exactly the ten reserved entity names;
--   * entity_id          integer (immutable historical fact; NO FK);
--   * action             text CHECK — exactly the ten reserved actions;
--   * actor_advisor_id   integer NULL, actor_name_snapshot text NOT NULL;
--   * occurred_at        timestamptz NOT NULL DEFAULT now();
--   * old_values/new_values/changes jsonb NULL; reason text NULL;
--   * subject_student_id / subject_application_id / subject_fellowship_id
--                         integer context columns (NO FKs by design);
--   * origin             text CHECK — exactly `user`, `system`, `migration`.
--
-- Event semantics (exactly the approved design):
--   * INSERT  -> old_values/changes NULL, new_values = safe snapshot,
--                action = 'created'.
--   * UPDATE  -> old/new/changes populated; `changes` contains ONLY whitelisted
--                fields that differ under `IS DISTINCT FROM`; a no-op or
--                technical-only update (no whitelisted field changed) records
--                nothing.
--   * Student/Fellowship  -> null→non-null `archived_at` is `archived`,
--                non-null→null is `restored`; any other meaningful change is
--                `updated`. Application updates are always `updated`.
--   * Actor/origin        -> non-null `auth.uid()` must resolve to exactly one
--                ACTIVE pre-bound public.advisor; its current `advisor_name`
--                is copied into `actor_name_snapshot` (a later rename cannot
--                rewrite a prior event) and origin = 'user'. A session without
--                a request actor writes actor_advisor_id = NULL,
--                actor_name_snapshot = 'System', origin = 'system'. An
--                authenticated but unresolved actor raises `42501`.
--
-- Snapshots are EXPLICIT `jsonb_build_object` whitelists (student, fellowship,
-- application below); technical, binding, credential, and future columns never
-- enter a snapshot or diff. JSON nulls are retained so a change to/from null is
-- unambiguous.
--
-- Security boundary:
--   * The helper lives in a NEW `private` schema. PUBLIC/anon/authenticated
--     receive no USAGE on `private` and no EXECUTE on the function; it is not a
--     Data API RPC and has no client writer path.
--   * The helper is SECURITY DEFINER with `SET search_path = ''` and every
--     relation/function reference is fully schema-qualified.
--   * `public.audit_event` enables RLS. ALL privileges are revoked from
--     PUBLIC/anon/authenticated; only `authenticated` receives SELECT and its
--     sole policy permits SELECT to `public.is_active_advisor()` (the existing
--     active-staff visibility predicate). Explicitly no INSERT/UPDATE/DELETE/
--     TRUNCATE for authenticated and no sequence usage, so neither staff nor
--     Admin can write audit rows.
--   * No event is created for pre-existing rows; `baseline_captured` is
--     reserved in the action CHECK but has no writer in this rollout.
--   * No JSONB GIN index is added; the six B-tree chronology indexes below
--     (every one carrying a stable `audit_id DESC` tie-breaker) cover the
--     documented history query paths.
--
-- Existing migrations, RLS policies, lifecycle RPCs/guards, amendment models,
-- and DELETE protections are untouched. `AFTER` timing follows the existing
-- `BEFORE` lifecycle guards, so denied direct archive writes never reach this
-- trigger, while a lifecycle transition emits exactly one canonical
-- archive/restore event.
--
-- Rollback: additive and unused by any write path; dropping the objects is a
-- separate forward migration and application rollback can simply stop reading
-- the audit surface. No down migration or data reset is provided.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Unexposed helper schema
--
-- PostgREST exposes only `public`/`graphql_public`; additionally we harden the
-- schema ACL so no product role has USAGE and the trigger function has no
-- client EXECUTE path.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

COMMENT ON SCHEMA private IS
    'Internal-only schema hosting the non-RPC SECURITY DEFINER audit trigger helper. Not exposed by the Data API; PUBLIC/anon/authenticated have no USAGE and no function EXECUTE.';

-- ---------------------------------------------------------------------------
-- 2. public.audit_event (immutable read model)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.audit_event_audit_id_seq
    AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.audit_event (
    audit_id   bigint NOT NULL DEFAULT nextval('public.audit_event_audit_id_seq'::regclass),
    entity_type text        NOT NULL,
    entity_id   integer     NOT NULL,
    action      text        NOT NULL,
    actor_advisor_id      integer,
    actor_name_snapshot   text     NOT NULL,
    occurred_at           timestamptz NOT NULL DEFAULT now(),
    old_values            jsonb,
    new_values            jsonb,
    changes               jsonb,
    reason                text,
    subject_student_id      integer,
    subject_application_id  integer,
    subject_fellowship_id   integer,
    origin text NOT NULL,
    CONSTRAINT audit_event_pkey PRIMARY KEY (audit_id),
    -- Exactly the ten reserved entity types; any other value is rejected.
    CONSTRAINT audit_event_entity_type_check CHECK (
        entity_type::text = ANY (ARRAY[
            'student', 'advisor', 'fellowship', 'application',
            'advising_meeting', 'advising_meeting_amendment',
            'fellowship_thursday', 'fellowship_thursday_amendment',
            'scholarship_history', 'scholarship_history_amendment'
        ])
    ),
    -- Exactly the ten reserved actions; extra values are rejected.
    CONSTRAINT audit_event_action_check CHECK (
        action::text = ANY (ARRAY[
            'created', 'updated', 'archived', 'restored', 'deactivated',
            'reactivated', 'role_changed', 'correction_added', 'voided',
            'baseline_captured'
        ])
    ),
    -- Exactly three origins. `migration` is reserved for a future explicitly
    -- authorized baseline operation and has no writer in this rollout.
    CONSTRAINT audit_event_origin_check CHECK (
        origin::text = ANY (ARRAY['user', 'system', 'migration'])
    )
);

ALTER SEQUENCE public.audit_event_audit_id_seq OWNED BY public.audit_event.audit_id;

COMMENT ON TABLE public.audit_event IS
    'Immutable, database-authored audit read model for the current-state student, fellowship, and application rows. Events are written only by the internal SECURITY DEFINER trigger helper inside the source mutation transaction; baseline rows are intentionally never fabricated. Readable by active authenticated advisors via RLS; immutable to all product roles including Admin.';

COMMENT ON COLUMN public.audit_event.audit_id IS
    'Stable monotonic event id; served by a sequence that is never exposed to client roles.';
COMMENT ON COLUMN public.audit_event.entity_type IS
    'Reserved entity vocabulary: student, advisor, fellowship, application, advising_meeting, advising_meeting_amendment, fellowship_thursday, fellowship_thursday_amendment, scholarship_history, scholarship_history_amendment.';
COMMENT ON COLUMN public.audit_event.entity_id IS
    'Immutable historical entity id at event time; deliberately has no foreign key.';
COMMENT ON COLUMN public.audit_event.action IS
    'Reserved action vocabulary: created, updated, archived, restored, deactivated, reactivated, role_changed, correction_added, voided, baseline_captured.';
COMMENT ON COLUMN public.audit_event.actor_advisor_id IS
    'Active advisor id resolved from auth.uid() at event time; NULL for a technical/system origin.';
COMMENT ON COLUMN public.audit_event.actor_name_snapshot IS
    'Advisor display name copied at event time (System for technical writes); a later advisor rename cannot rewrite a prior event.';
COMMENT ON COLUMN public.audit_event.occurred_at IS
    'Transaction timestamp of the audited mutation.';
COMMENT ON COLUMN public.audit_event.old_values IS
    'Explicit whitelisted snapshot of the row BEFORE a meaningful UPDATE; NULL for INSERT.';
COMMENT ON COLUMN public.audit_event.new_values IS
    'Explicit whitelisted snapshot of the row AFTER the insertion/mutation.';
COMMENT ON COLUMN public.audit_event.changes IS
    'Only whitelisted business fields that differ between old and new under IS DISTINCT FROM; {} never yields an event and NULL for INSERT.';
COMMENT ON COLUMN public.audit_event.reason IS
    'Optional human-supplied reason; not populated by this rollout.';
COMMENT ON COLUMN public.audit_event.subject_student_id IS
    'Immutable subject student context at mutation time; NOT a foreign key.';
COMMENT ON COLUMN public.audit_event.subject_application_id IS
    'Immutable subject application context at mutation time; NOT a foreign key.';
COMMENT ON COLUMN public.audit_event.subject_fellowship_id IS
    'Immutable subject fellowship context at mutation time; NOT a foreign key.';
COMMENT ON COLUMN public.audit_event.origin IS
    'user = authenticated active-advisor write, system = no request actor (technical/service_role), migration = reserved for an explicitly authorized baseline operation.';

-- ---------------------------------------------------------------------------
-- 3. Indexes
--
-- Required chronological B-tree indexes (entity, actor, each subject context,
-- and global) each ending in the stable `audit_id DESC` tie-breaker. No JSONB
-- GIN index is added by design.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_event_entity_chronology
    ON public.audit_event (entity_type, entity_id, occurred_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_actor_chronology
    ON public.audit_event (actor_advisor_id, occurred_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_subject_student_chronology
    ON public.audit_event (subject_student_id, occurred_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_subject_application_chronology
    ON public.audit_event (subject_application_id, occurred_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_subject_fellowship_chronology
    ON public.audit_event (subject_fellowship_id, occurred_at DESC, audit_id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_occurred_at_chronology
    ON public.audit_event (occurred_at DESC, audit_id DESC);

-- ---------------------------------------------------------------------------
-- 4. RLS and privilege boundary
--
-- RLS is enabled; direct table DML and sequence usage are revoked from every
-- product role; the sole grant is SELECT to `authenticated` gated by the
-- existing active-advisor predicate. There are no INSERT/UPDATE/DELETE
-- policies and no INSERT/UPDATE/DELETE/TRUNCATE grants, so there is no client
-- audit writer.
-- ---------------------------------------------------------------------------
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.audit_event FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_event TO authenticated;

REVOKE ALL ON SEQUENCE public.audit_event_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE POLICY audit_event_select_active_advisor
    ON public.audit_event
    FOR SELECT
    TO authenticated
    USING (public.is_active_advisor());

-- ---------------------------------------------------------------------------
-- 5. Internal trigger helper: private.audit_current_state_change()
--
-- SECURITY DEFINER, `SET search_path = ''`, fully schema-qualified references.
-- It is invoked ONLY by the AFTER triggers below (a trigger mechanism needs no
-- EXECUTE grant); no client role has EXECUTE, so it is not a callable RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.audit_current_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_entity_type text;
    v_action text;
    v_entity_id integer;
    v_subject_student_id integer;
    v_subject_application_id integer;
    v_subject_fellowship_id integer;
    v_actor uuid;
    v_actor_advisor_id integer;
    v_actor_name text;
    v_origin text;
    v_old_values jsonb;
    v_new_values jsonb;
    v_changes jsonb;
    v_key text;
    v_keys text[];
    -- Explicit snapshot/diff whitelist keys; technical columns never appear.
    v_student_keys constant text[] := ARRAY[
        'full_name', 'email', 'is_ch_student', 'major', 'minor', 'gpa',
        'class_standing', 'us_citizen', 'age', 'gender', 'pronouns',
        'race_ethnicity', 'languages', 'first_gen', 'honors_college',
        'archived_at'
    ];
    v_fellowship_keys constant text[] := ARRAY['fellowship_name', 'archived_at'];
    v_application_keys constant text[] := ARRAY[
        'student_id', 'fellowship_id', 'application_year',
        'destination_country', 'stage_of_application',
        'is_semi_finalist', 'is_finalist'
    ];
BEGIN
    -- Defense in depth: this helper is wired only to the three current-state
    -- tables; a future accidental attachment must never audit another entity.
    IF TG_TABLE_NAME NOT IN ('student', 'fellowship', 'application') THEN
        RETURN NULL;
    END IF;

    v_entity_type := TG_TABLE_NAME;
    v_actor := auth.uid();

    -- -----------------------------------------------------------------------
    -- Actor resolution and origin classification.
    --
    -- A non-null request actor MUST resolve to exactly one active, pre-bound
    -- advisor; failure to resolve raises 42501 and aborts the source mutation.
    -- A session without a request actor (technical/service_role/DBA) records a
    -- System name snapshot with system origin.
    -- -----------------------------------------------------------------------
    IF v_actor IS NOT NULL THEN
        IF (
            SELECT count(*)::integer
              FROM public.advisor a
             WHERE a.auth_user_id = v_actor
               AND a.is_active = true
        ) <> 1 THEN
            RAISE EXCEPTION
                'authenticated actor has no unique active bound advisor; audit write refused'
                USING ERRCODE = '42501';
        END IF;

        SELECT a.advisor_id, a.advisor_name
          INTO v_actor_advisor_id, v_actor_name
          FROM public.advisor a
         WHERE a.auth_user_id = v_actor
           AND a.is_active = true;

        v_origin := 'user';
    ELSE
        v_actor_advisor_id := NULL;
        v_actor_name := 'System';
        v_origin := 'system';
    END IF;

    IF TG_OP = 'INSERT'
    THEN
        -- A created row: snapshot NEW only; old_values/changes are NULL.
        v_action := 'created';
        v_old_values := NULL;
        v_changes := NULL;

        IF v_entity_type = 'student' THEN
            v_new_values := jsonb_build_object(
                'full_name', NEW.full_name,
                'email', NEW.email,
                'is_ch_student', NEW.is_ch_student,
                'major', NEW.major,
                'minor', NEW.minor,
                'gpa', NEW.gpa,
                'class_standing', NEW.class_standing,
                'us_citizen', NEW.us_citizen,
                'age', NEW.age,
                'gender', NEW.gender,
                'pronouns', NEW.pronouns,
                'race_ethnicity', NEW.race_ethnicity,
                'languages', NEW.languages,
                'first_gen', NEW.first_gen,
                'honors_college', NEW.honors_college,
                'archived_at', NEW.archived_at
            );
            v_entity_id := NEW.student_id;
            v_subject_student_id := NEW.student_id;
        ELSIF v_entity_type = 'fellowship' THEN
            v_new_values := jsonb_build_object(
                'fellowship_name', NEW.fellowship_name,
                'archived_at', NEW.archived_at
            );
            v_entity_id := NEW.fellowship_id;
            v_subject_fellowship_id := NEW.fellowship_id;
        ELSE
            v_new_values := jsonb_build_object(
                'student_id', NEW.student_id,
                'fellowship_id', NEW.fellowship_id,
                'application_year', NEW.application_year,
                'destination_country', NEW.destination_country,
                'stage_of_application', NEW.stage_of_application,
                'is_semi_finalist', NEW.is_semi_finalist,
                'is_finalist', NEW.is_finalist
            );
            v_entity_id := NEW.application_id;
            v_subject_student_id := NEW.student_id;
            v_subject_application_id := NEW.application_id;
            v_subject_fellowship_id := NEW.fellowship_id;
        END IF;
    ELSE
        -- UPDATE: snapshot OLD/NEW from the SAME whitelist and diff it.
        IF v_entity_type = 'student' THEN
            v_old_values := jsonb_build_object(
                'full_name', OLD.full_name,
                'email', OLD.email,
                'is_ch_student', OLD.is_ch_student,
                'major', OLD.major,
                'minor', OLD.minor,
                'gpa', OLD.gpa,
                'class_standing', OLD.class_standing,
                'us_citizen', OLD.us_citizen,
                'age', OLD.age,
                'gender', OLD.gender,
                'pronouns', OLD.pronouns,
                'race_ethnicity', OLD.race_ethnicity,
                'languages', OLD.languages,
                'first_gen', OLD.first_gen,
                'honors_college', OLD.honors_college,
                'archived_at', OLD.archived_at
            );
            v_new_values := jsonb_build_object(
                'full_name', NEW.full_name,
                'email', NEW.email,
                'is_ch_student', NEW.is_ch_student,
                'major', NEW.major,
                'minor', NEW.minor,
                'gpa', NEW.gpa,
                'class_standing', NEW.class_standing,
                'us_citizen', NEW.us_citizen,
                'age', NEW.age,
                'gender', NEW.gender,
                'pronouns', NEW.pronouns,
                'race_ethnicity', NEW.race_ethnicity,
                'languages', NEW.languages,
                'first_gen', NEW.first_gen,
                'honors_college', NEW.honors_college,
                'archived_at', NEW.archived_at
            );
            v_keys := v_student_keys;
            v_entity_id := NEW.student_id;
            v_subject_student_id := NEW.student_id;
        ELSIF v_entity_type = 'fellowship' THEN
            v_old_values := jsonb_build_object(
                'fellowship_name', OLD.fellowship_name,
                'archived_at', OLD.archived_at
            );
            v_new_values := jsonb_build_object(
                'fellowship_name', NEW.fellowship_name,
                'archived_at', NEW.archived_at
            );
            v_keys := v_fellowship_keys;
            v_entity_id := NEW.fellowship_id;
            v_subject_fellowship_id := NEW.fellowship_id;
        ELSE
            v_old_values := jsonb_build_object(
                'student_id', OLD.student_id,
                'fellowship_id', OLD.fellowship_id,
                'application_year', OLD.application_year,
                'destination_country', OLD.destination_country,
                'stage_of_application', OLD.stage_of_application,
                'is_semi_finalist', OLD.is_semi_finalist,
                'is_finalist', OLD.is_finalist
            );
            v_new_values := jsonb_build_object(
                'student_id', NEW.student_id,
                'fellowship_id', NEW.fellowship_id,
                'application_year', NEW.application_year,
                'destination_country', NEW.destination_country,
                'stage_of_application', NEW.stage_of_application,
                'is_semi_finalist', NEW.is_semi_finalist,
                'is_finalist', NEW.is_finalist
            );
            v_keys := v_application_keys;
            v_entity_id := NEW.application_id;
            v_subject_student_id := NEW.student_id;
            v_subject_application_id := NEW.application_id;
            v_subject_fellowship_id := NEW.fellowship_id;
        END IF;

        -- Lifecycle classification first: an archive/restore transition is a
        -- single canonical event, never also a generic update.
        v_action := 'updated';
        IF v_entity_type IN ('student', 'fellowship') THEN
            IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
                v_action := 'archived';
            ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
                v_action := 'restored';
            END IF;
        END IF;

        -- Diff only whitelisted fields under IS DISTINCT FROM; JSON nulls are
        -- preserved so a change to/from null is unambiguous.
        v_changes := '{}'::jsonb;
        FOR v_key IN SELECT unnest(v_keys) LOOP
            IF v_old_values -> v_key IS DISTINCT FROM v_new_values -> v_key THEN
                v_changes := v_changes || jsonb_build_object(
                    v_key,
                    jsonb_build_object(
                        'old', v_old_values -> v_key,
                        'new', v_new_values -> v_key
                    )
                );
            END IF;
        END LOOP;

        -- A no-op or technical-only update (no whitelisted field changed)
        -- records no event.
        IF v_changes = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
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
        v_old_values,
        v_new_values,
        v_changes,
        v_subject_student_id,
        v_subject_application_id,
        v_subject_fellowship_id,
        v_origin
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.audit_current_state_change()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.audit_current_state_change() IS
    'Internal SECURITY DEFINER trigger helper: writes exactly one immutable public.audit_event per INSERT or meaningful UPDATE of student/fellowship/application inside the source transaction. Explicit snapshot/diff whitelists, unique active-advisor actor resolution (or System/system fallback), lifecycle archive/restore classification, and no-op suppression. Runs with empty search_path and fully qualified references. Not callable by any client role and not exposed as a Data API RPC.';

-- ---------------------------------------------------------------------------
-- 6. AFTER triggers on the current-state tables
--
-- `AFTER` timing follows the existing `BEFORE` lifecycle guards: denied direct
-- archive writes never reach this trigger, while the lifecycle RPC update
-- (archived_at stamp) fires exactly one canonical archive/restore event.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_student_current_state ON public.student;
CREATE TRIGGER trg_audit_student_current_state
    AFTER INSERT OR UPDATE ON public.student
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_current_state_change();

COMMENT ON TRIGGER trg_audit_student_current_state ON public.student IS
    'Writes one immutable audit event for every student INSERT or meaningful UPDATE (lifecycle archive/restore transitions classified accordingly).';

DROP TRIGGER IF EXISTS trg_audit_fellowship_current_state ON public.fellowship;
CREATE TRIGGER trg_audit_fellowship_current_state
    AFTER INSERT OR UPDATE ON public.fellowship
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_current_state_change();

COMMENT ON TRIGGER trg_audit_fellowship_current_state ON public.fellowship IS
    'Writes one immutable audit event for every fellowship INSERT or meaningful UPDATE (lifecycle archive/restore transitions classified accordingly).';

DROP TRIGGER IF EXISTS trg_audit_application_current_state ON public.application;
CREATE TRIGGER trg_audit_application_current_state
    AFTER INSERT OR UPDATE ON public.application
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_current_state_change();

COMMENT ON TRIGGER trg_audit_application_current_state ON public.application IS
    'Writes one immutable audit event for every application INSERT or meaningful UPDATE.';
