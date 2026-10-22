-- ============================================================================
-- OCF Fellowship Management System — Protected current-state writers
--
-- Forward-only, additive/replacement migration for the approved
-- `historical-audit-timeline` design (AI-DLC, Plan Work 1). It introduces
-- database-enforced optimistic concurrency for the four mutable current-state
-- entities and moves every normal authenticated mutation onto a narrow,
-- expected-version `SECURITY DEFINER` writer RPC:
--
--   1. adds `row_version integer NOT NULL DEFAULT 1` and
--      `updated_at timestamptz NOT NULL DEFAULT now()` to `student`,
--      `fellowship`, `application`, and `advisor`. INSERT defaults establish
--      version 1 and a database-authored timestamp for every existing/new row
--      (technical metadata only; no audit backfill, no fabricated history);
--   2. adds a database-owned BEFORE UPDATE trigger
--      (`private.set_current_state_row_version`) that compares a strict
--      per-entity allowlist of meaningful business/lifecycle fields: a
--      semantic change increments the OLD row version exactly once and stamps
--      `updated_at := now()`; a no-op or technical-only restatement preserves
--      BOTH values. The version/timestamp columns are deliberately NOT in any
--      existing audit trigger allowlist, so their technical maintenance can
--      never create a visible `audit_event` change;
--   3. introduces narrow, entity-specific expected-version writer RPCs whose
--      permitted fields mirror the existing edit workflows:
--        * `public.update_student_profile(...)`
--        * `public.update_fellowship(...)`
--        * `public.update_application(...)`
--        * `public.update_my_advisor_profile(...)`  (self profile name)
--      Each authorizes internally, locks the target, checks
--      `p_expected_version` BEFORE any change, writes only permitted explicit
--      fields, and returns a display-safe projection with its new version;
--   4. extends/replaces the existing lifecycle, role, and profile writer
--      contracts with non-overloaded unique signatures that accept the
--      expected version where a pre-existing row changes:
--        * `public.lifecycle_transition(text, text, integer, text, integer)`
--        * `public.set_advisor_role(integer, text, text, integer, integer)`
--        * `public.update_advisor_profile_name(integer, text, integer)`
--        * `public.provision_advisor(...)` (insert-only; returns version 1)
--      The old signatures are DROPped in the same forward migration so a
--      caller can never bypass the version precondition through legacy arity;
--   5. revokes direct authenticated `UPDATE` on the four current-state tables
--      and drops their direct UPDATE policies, so the expected-version check
--      is non-bypassable for authenticated product sessions. SELECT and the
--      intended INSERT surfaces keep their existing RLS. The definer writers
--      run as the migration owner and are unaffected by the revoke.
--
-- Stale outcome: `RAISE SQLSTATE 'PT409'` with a fixed non-sensitive message.
-- PostgREST/supabase-js surfaces this as `error.code === 'PT409'`; malformed
-- expected versions use `22023`; authorization (`42501`) and missing-row
-- (`P0002`) outcomes stay distinguishable from a conflict. A stale rejection
-- performs no business mutation, no version increment, no timestamp update,
-- and (because the row is untouched) no audit event.
--
-- Security boundary: every writer is SECURITY DEFINER with
-- `SET search_path = ''` and fully qualified references, revokes
-- PUBLIC/anon execution, and grants only its intended role. Each rechecks its
-- caller authorization internally. The version trigger is SECURITY INVOKER
-- (it mutates only NEW) with client EXECUTE revoked.
--
-- Preserved unchanged: immutable `audit_event` writer/read protections and
-- audit-trigger atomicity, existing lifecycle guards root archive/deactivate
-- authority, the effective-Admin boundary, the atomic role-change boundary,
-- all RLS SELECT/INSERT policies, every FK, and append-only history.
-- Forward-only; no existing business row is edited, deleted, or reset.
-- ============================================================================


-- ============================================================================
-- 1. Current-state version/timestamp metadata
--
-- Existing rows receive version 1 and the migration-time timestamp (technical
-- metadata, never a fabricated event or history). INSERT defaults keep every
-- future row non-null.
-- ============================================================================
ALTER TABLE public.student
    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.fellowship
    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.application
    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.advisor
    ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.student.row_version IS
    'Monotonic optimistic-concurrency version. 1 at insert; incremented exactly once by a meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.student.updated_at IS
    'Database-authored timestamp of the last meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.fellowship.row_version IS
    'Monotonic optimistic-concurrency version. 1 at insert; incremented exactly once by a meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.fellowship.updated_at IS
    'Database-authored timestamp of the last meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.application.row_version IS
    'Monotonic optimistic-concurrency version. 1 at insert; incremented exactly once by a meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.application.updated_at IS
    'Database-authored timestamp of the last meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.advisor.row_version IS
    'Monotonic optimistic-concurrency version. 1 at insert; incremented exactly once by a meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';
COMMENT ON COLUMN public.advisor.updated_at IS
    'Database-authored timestamp of the last meaningful business/lifecycle UPDATE. Technical column: never in an audit snapshot/diff.';


-- ============================================================================
-- 2. Semantic row-version trigger
--
-- SECURITY INVOKER (it only rewrites NEW). The per-entity allowlist is exactly
-- the meaningful business/lifecycle surface already audited by the immutable
-- audit helpers — technical, binding, credential, and timestamp columns are
-- structurally excluded. `to_jsonb(NEW)` is compared key-by-key so no column
-- is referenced dynamically.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.set_current_state_row_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_keys text[];
    v_key text;
    v_changed boolean := false;
    v_new jsonb;
    v_old jsonb;
BEGIN
    IF TG_TABLE_NAME = 'student' THEN
        v_keys := ARRAY[
            'full_name', 'email', 'is_ch_student', 'major', 'minor', 'gpa',
            'class_standing', 'us_citizen', 'age', 'gender', 'pronouns',
            'race_ethnicity', 'languages', 'first_gen', 'honors_college',
            'archived_at'
        ];
    ELSIF TG_TABLE_NAME = 'fellowship' THEN
        v_keys := ARRAY['fellowship_name', 'archived_at'];
    ELSIF TG_TABLE_NAME = 'application' THEN
        v_keys := ARRAY[
            'student_id', 'fellowship_id', 'application_year',
            'destination_country', 'stage_of_application',
            'is_semi_finalist', 'is_finalist'
        ];
    ELSIF TG_TABLE_NAME = 'advisor' THEN
        v_keys := ARRAY['advisor_name', 'email', 'role', 'is_active'];
    ELSE
        -- Defense in depth: never mutate an unattached/future table.
        RETURN NEW;
    END IF;

    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);

    FOR v_key IN SELECT unnest(v_keys) LOOP
        IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
            v_changed := true;
            EXIT;
        END IF;
    END LOOP;

    IF v_changed THEN
        -- Exactly one increment per meaningful statement.
        NEW.row_version := OLD.row_version + 1;
        NEW.updated_at := now();
    ELSE
        -- No-op or technical-only restatement: preserve both values.
        NEW.row_version := OLD.row_version;
        NEW.updated_at := OLD.updated_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_current_state_row_version()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.set_current_state_row_version()
    TO service_role;

COMMENT ON FUNCTION private.set_current_state_row_version() IS
    'Internal BEFORE UPDATE trigger: increments row_version and stamps updated_at exactly once for a meaningful business/lifecycle change on student/fellowship/application/advisor; preserves both values for a no-op or technical-only restatement. Uses the same explicit meaningful-field allowlist the immutable audit helpers use; version/timestamp columns never enter an audit snapshot/diff. Not callable by any client role.';

DROP TRIGGER IF EXISTS trg_student_current_state_version ON public.student;
CREATE TRIGGER trg_student_current_state_version
    BEFORE UPDATE ON public.student
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_fellowship_current_state_version ON public.fellowship;
CREATE TRIGGER trg_fellowship_current_state_version
    BEFORE UPDATE ON public.fellowship
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_application_current_state_version ON public.application;
CREATE TRIGGER trg_application_current_state_version
    BEFORE UPDATE ON public.application
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_advisor_current_state_version ON public.advisor;
CREATE TRIGGER trg_advisor_current_state_version
    BEFORE UPDATE ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();


-- ============================================================================
-- 3. Narrow expected-version writer RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3a. public.update_student_profile
--
-- Active-advisor-only full replacement of the student's editable surface
-- (mirrors the roster + detail sectioned edit forms; unmatched columns are
-- passed through unchanged via the RPC's NULL-preserving nullable fields).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_student_profile(
    p_student_id integer,
    p_expected_version integer,
    p_full_name text,
    p_email text,
    p_is_ch_student boolean,
    p_major text,
    p_minor text,
    p_gpa numeric,
    p_class_standing text,
    p_us_citizen boolean,
    p_age integer,
    p_gender text,
    p_pronouns text,
    p_race_ethnicity text,
    p_languages text,
    p_first_gen boolean,
    p_honors_college boolean
)
RETURNS TABLE (
    student_id integer,
    full_name character varying,
    email character varying,
    is_ch_student boolean,
    major character varying,
    minor character varying,
    gpa numeric,
    class_standing character varying,
    us_citizen boolean,
    age integer,
    gender character varying,
    pronouns character varying,
    race_ethnicity character varying,
    languages character varying,
    first_gen boolean,
    honors_college boolean,
    archived_at timestamptz,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current integer;
BEGIN
    IF p_student_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_student_profile requires a student id and an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
        RAISE EXCEPTION 'update_student_profile requires a non-blank full_name'
            USING ERRCODE = '22023';
    END IF;
    IF p_email IS NULL OR btrim(p_email) = '' THEN
        RAISE EXCEPTION 'update_student_profile requires a non-blank email'
            USING ERRCODE = '22023';
    END IF;
    IF p_is_ch_student IS NULL OR p_us_citizen IS NULL
       OR p_first_gen IS NULL OR p_honors_college IS NULL THEN
        RAISE EXCEPTION 'update_student_profile requires boolean student flags'
            USING ERRCODE = '22023';
    END IF;

    -- Authorization: the existing active-advisor boundary (RLS equivalent).
    IF NOT public.is_active_advisor() THEN
        RAISE EXCEPTION 'only an authenticated active advisor may update a student profile'
            USING ERRCODE = '42501';
    END IF;

    -- Lock the target, confirm it exists, and compare the expected version
    -- BEFORE any change (a conflict leaves the row untouched).
    SELECT s.row_version
      INTO v_current
      FROM public.student AS s
     WHERE s.student_id = p_student_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'student % does not exist', p_student_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the student was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    UPDATE public.student AS s
       SET full_name = btrim(p_full_name),
           email = btrim(p_email),
           is_ch_student = p_is_ch_student,
           major = p_major,
           minor = p_minor,
           gpa = p_gpa,
           class_standing = p_class_standing,
           us_citizen = p_us_citizen,
           age = p_age,
           gender = p_gender,
           pronouns = p_pronouns,
           race_ethnicity = p_race_ethnicity,
           languages = p_languages,
           first_gen = p_first_gen,
           honors_college = p_honors_college
     WHERE s.student_id = p_student_id;

    RETURN QUERY
    SELECT s.student_id, s.full_name, s.email, s.is_ch_student, s.major,
           s.minor, s.gpa, s.class_standing, s.us_citizen, s.age, s.gender,
           s.pronouns, s.race_ethnicity, s.languages, s.first_gen,
           s.honors_college, s.archived_at, s.row_version, s.updated_at
      FROM public.student AS s
     WHERE s.student_id = p_student_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_student_profile(
    integer, integer, text, text, boolean, text, text, numeric, text, boolean,
    integer, text, text, text, text, boolean, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_student_profile(
    integer, integer, text, text, boolean, text, text, numeric, text, boolean,
    integer, text, text, text, text, boolean, boolean
) TO authenticated;

COMMENT ON FUNCTION public.update_student_profile(
    integer, integer, text, text, boolean, text, text, numeric, text, boolean,
    integer, text, text, text, text, boolean, boolean
) IS
    'Active-advisor expected-version writer for a student profile: authorizes, locks the row, requires p_expected_version (PT409 on mismatch; 22023 on malformed), writes the permitted explicit fields, and returns a display-safe projection with its new version. Direct authenticated UPDATE on student is revoked.';


-- ---------------------------------------------------------------------------
-- 3b. public.update_fellowship
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_fellowship(
    p_fellowship_id integer,
    p_expected_version integer,
    p_fellowship_name text
)
RETURNS TABLE (
    fellowship_id integer,
    fellowship_name character varying,
    archived_at timestamptz,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current integer;
BEGIN
    IF p_fellowship_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_fellowship requires a fellowship id and an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_fellowship_name IS NULL OR btrim(p_fellowship_name) = '' THEN
        RAISE EXCEPTION 'update_fellowship requires a non-blank fellowship_name'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_active_advisor() THEN
        RAISE EXCEPTION 'only an authenticated active advisor may update a fellowship'
            USING ERRCODE = '42501';
    END IF;

    SELECT f.row_version
      INTO v_current
      FROM public.fellowship AS f
     WHERE f.fellowship_id = p_fellowship_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'fellowship % does not exist', p_fellowship_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the fellowship was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    UPDATE public.fellowship AS f
       SET fellowship_name = btrim(p_fellowship_name)
     WHERE f.fellowship_id = p_fellowship_id;

    RETURN QUERY
    SELECT f.fellowship_id, f.fellowship_name, f.archived_at,
           f.row_version, f.updated_at
      FROM public.fellowship AS f
     WHERE f.fellowship_id = p_fellowship_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_fellowship(integer, integer, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_fellowship(integer, integer, text)
    TO authenticated;

COMMENT ON FUNCTION public.update_fellowship(integer, integer, text) IS
    'Active-advisor expected-version writer for a fellowship name: authorizes, locks the row, requires p_expected_version (PT409 on mismatch; 22023 on malformed), writes only the name, and returns a display-safe projection with its new version. Direct authenticated UPDATE on fellowship is revoked.';


-- ---------------------------------------------------------------------------
-- 3c. public.update_application
--
-- Full replacement of the editable application surface. A RE-LINK
-- (student_id / fellowship_id change) is explicitly validated against the
-- existing ACTIVE-parent boundary, because the definer path bypasses the
-- invoker-security `guard_application_archive_parents` trigger. Historical
-- re-saves that keep an archived parent reference pass through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_application(
    p_application_id integer,
    p_expected_version integer,
    p_student_id integer,
    p_fellowship_id integer,
    p_application_year integer,
    p_destination_country text,
    p_stage_of_application text,
    p_is_semi_finalist boolean,
    p_is_finalist boolean
)
RETURNS TABLE (
    application_id integer,
    student_id integer,
    fellowship_id integer,
    application_year smallint,
    destination_country character varying,
    stage_of_application character varying,
    is_semi_finalist boolean,
    is_finalist boolean,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current integer;
    v_current_student integer;
    v_current_fellowship integer;
BEGIN
    IF p_application_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_application requires an application id and an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_student_id IS NULL OR p_fellowship_id IS NULL
       OR p_stage_of_application IS NULL
       OR p_is_semi_finalist IS NULL OR p_is_finalist IS NULL THEN
        RAISE EXCEPTION 'update_application requires student_id, fellowship_id, stage, and finalist flags'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_active_advisor() THEN
        RAISE EXCEPTION 'only an authenticated active advisor may update an application'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.row_version, a.student_id, a.fellowship_id
      INTO v_current, v_current_student, v_current_fellowship
      FROM public.application AS a
     WHERE a.application_id = p_application_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'application % does not exist', p_application_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the application was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    -- Preserve the active-parent boundary for an actual re-link only.
    IF p_student_id IS DISTINCT FROM v_current_student
       AND NOT EXISTS (
           SELECT 1 FROM public.student AS s
            WHERE s.student_id = p_student_id
              AND s.archived_at IS NULL
       ) THEN
        RAISE EXCEPTION 'cannot link an application to archived or missing student %',
            p_student_id
            USING ERRCODE = '42501';
    END IF;

    IF p_fellowship_id IS DISTINCT FROM v_current_fellowship
       AND NOT EXISTS (
           SELECT 1 FROM public.fellowship AS f
            WHERE f.fellowship_id = p_fellowship_id
              AND f.archived_at IS NULL
       ) THEN
        RAISE EXCEPTION 'cannot link an application to archived or missing fellowship %',
            p_fellowship_id
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.application AS a
       SET student_id = p_student_id,
           fellowship_id = p_fellowship_id,
           application_year = p_application_year,
           destination_country = p_destination_country,
           stage_of_application = p_stage_of_application,
           is_semi_finalist = p_is_semi_finalist,
           is_finalist = p_is_finalist
     WHERE a.application_id = p_application_id;

    RETURN QUERY
    SELECT a.application_id, a.student_id, a.fellowship_id,
           a.application_year, a.destination_country,
           a.stage_of_application, a.is_semi_finalist, a.is_finalist,
           a.row_version, a.updated_at
      FROM public.application AS a
     WHERE a.application_id = p_application_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) TO authenticated;

COMMENT ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) IS
    'Active-advisor expected-version writer for an application: authorizes, locks the row, requires p_expected_version (PT409 on mismatch; 22023 on malformed), validates an actual parent re-link against the ACTIVE parent boundary, writes the permitted explicit fields, and returns a display-safe projection with its new version. Direct authenticated UPDATE on application is revoked.';


-- ---------------------------------------------------------------------------
-- 3d. public.update_my_advisor_profile
--
-- Self-service advisor display-name edit. The actor is derived from
-- auth.uid() (never a parameter) and must be an active, pre-bound advisor; the
-- row is always the caller's own. Only advisor_name is writable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_my_advisor_profile(
    p_expected_version integer,
    p_advisor_name text
)
RETURNS TABLE (
    advisor_id integer,
    advisor_name character varying,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_target integer;
    v_current integer;
BEGIN
    IF p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_my_advisor_profile requires an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_advisor_name IS NULL OR btrim(p_advisor_name) = '' THEN
        RAISE EXCEPTION 'update_my_advisor_profile requires a non-blank advisor_name'
            USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.char_length(btrim(p_advisor_name)) > 120 THEN
        RAISE EXCEPTION 'advisor_name must be 120 characters or fewer'
            USING ERRCODE = '22023';
    END IF;

    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'updating your advisor profile requires an authenticated session'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.advisor_id, a.row_version
      INTO v_target, v_current
      FROM public.advisor AS a
     WHERE a.auth_user_id = v_actor
       AND a.is_active = true
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'the authenticated session has no unique active bound advisor row'
            USING ERRCODE = '42501';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'your advisor profile was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    UPDATE public.advisor AS a
       SET advisor_name = btrim(p_advisor_name)
     WHERE a.advisor_id = v_target;

    RETURN QUERY
    SELECT a.advisor_id, a.advisor_name, a.row_version, a.updated_at
      FROM public.advisor AS a
     WHERE a.advisor_id = v_target;
END;
$$;

REVOKE ALL ON FUNCTION public.update_my_advisor_profile(integer, text)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_my_advisor_profile(integer, text)
    TO authenticated;

COMMENT ON FUNCTION public.update_my_advisor_profile(integer, text) IS
    'Authenticated self-service expected-version writer for the caller''s own advisor display name. Actor derived from auth.uid() only; requires a current active bound advisor row; writes only advisor_name. PT409 on stale version, 22023 on malformed input. Returns a display-safe projection with its new version. Direct authenticated UPDATE on advisor is revoked.';


-- ============================================================================
-- 4. Versioned replacement of lifecycle / role / profile writers
--
-- Old signatures are dropped so legacy arity can never bypass the required
-- expected version.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 4a. public.update_advisor_profile_name (effective-Admin peer name edit)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_advisor_profile_name(integer, text);

CREATE OR REPLACE FUNCTION public.update_advisor_profile_name(
    p_advisor_id integer,
    p_advisor_name text,
    p_expected_version integer
)
RETURNS TABLE (
    advisor_id integer,
    advisor_name character varying,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_actor_advisor_id integer;
    v_current integer;
BEGIN
    IF p_advisor_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_advisor_profile_name requires an advisor id and an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_advisor_name IS NULL OR btrim(p_advisor_name) = '' THEN
        RAISE EXCEPTION 'update_advisor_profile_name requires a non-blank advisor_name'
            USING ERRCODE = '22023';
    END IF;
    IF pg_catalog.char_length(btrim(p_advisor_name)) > 120 THEN
        RAISE EXCEPTION 'advisor_name must be 120 characters or fewer'
            USING ERRCODE = '22023';
    END IF;

    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'updating another advisor''s name requires an authenticated administrator session'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_effective_admin() THEN
        RAISE EXCEPTION 'only an effective administrator may update another advisor''s name (Auth app_metadata ocf_admin=true and an active bound advisor row are required)'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.advisor_id
      INTO v_actor_advisor_id
      FROM public.advisor AS a
     WHERE a.auth_user_id = v_actor
       AND a.is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'the authenticated session has no unique active bound advisor row; peer name update refused'
            USING ERRCODE = '42501';
    END IF;

    IF p_advisor_id = v_actor_advisor_id THEN
        RAISE EXCEPTION 'use the self-service profile update to change your own name; this route updates another advisor'
            USING ERRCODE = '22023';
    END IF;

    SELECT a.row_version
      INTO v_current
      FROM public.advisor AS a
     WHERE a.advisor_id = p_advisor_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'advisor % does not exist', p_advisor_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the advisor was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.advisor AS a
         WHERE a.advisor_id <> p_advisor_id
           AND a.advisor_name = btrim(p_advisor_name)
    ) THEN
        RAISE EXCEPTION 'advisor_name % is already used by another advisor',
            btrim(p_advisor_name)
            USING ERRCODE = '23505';
    END IF;

    UPDATE public.advisor AS a
       SET advisor_name = btrim(p_advisor_name)
     WHERE a.advisor_id = p_advisor_id;

    RETURN QUERY
    SELECT a.advisor_id, a.advisor_name, a.row_version, a.updated_at
      FROM public.advisor AS a
     WHERE a.advisor_id = p_advisor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_advisor_profile_name(integer, text, integer)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_advisor_profile_name(integer, text, integer)
    TO authenticated;

COMMENT ON FUNCTION public.update_advisor_profile_name(integer, text, integer) IS
    'Authenticated-only expected-version writer: an effective Admin (actor derived from auth.uid() and validated with public.is_effective_admin()) updates ANOTHER advisor''s display name. Only advisor_name is writable, the caller''s own row is refused, the target must exist, and p_expected_version is required (PT409 on mismatch). The existing advisor audit trigger emits exactly one attributed updated event (or none for a no-op). EXECUTE pinned to authenticated only.';


-- ---------------------------------------------------------------------------
-- 4b. public.set_advisor_role (atomic trusted role change; service_role only)
--
-- Adds the target's expected version. The version comparison happens BEFORE
-- the auth.users claim write, so a stale rejection changes neither the claim
-- nor the display role. The existing semantic version trigger still increments
-- the display-role row version exactly once.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_advisor_role(integer, text, text, integer);

CREATE OR REPLACE FUNCTION public.set_advisor_role(
    p_advisor_id integer,
    p_role text,
    p_reason text,
    p_actor_id integer,
    p_expected_version integer
)
RETURNS TABLE (advisor_id integer, role text, auth_user_id uuid, row_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_user_id uuid;
    v_updated integer;
    v_actor_name text;
    v_current_role text;
    v_current_active boolean;
    v_current_version integer;
    v_target_is_durable_admin boolean;
    v_membership integer;
    v_old_values jsonb;
    v_new_values jsonb;
    v_new_version integer;
    v_lock_key constant bigint :=
        pg_catalog.hashtextextended('ocf.advisor_admin_membership', 0);
BEGIN
    IF p_role IS NULL OR p_role NOT IN ('Admin', 'Advisor') THEN
        RAISE EXCEPTION 'set_advisor_role role must be Admin or Advisor'
            USING ERRCODE = '22023';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'set_advisor_role requires a non-blank reason'
            USING ERRCODE = '22023';
    END IF;
    IF p_advisor_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'set_advisor_role requires an advisor id and an expected version'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

    v_actor_name := private.lock_and_assert_durable_effective_admin(p_actor_id);

    SELECT a.auth_user_id, a.role, a.is_active, a.row_version
      INTO v_auth_user_id, v_current_role, v_current_active, v_current_version
      FROM public.advisor AS a
     WHERE a.advisor_id = p_advisor_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'advisor % does not exist', p_advisor_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current_version IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the advisor was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'advisor % is not bound to an Auth identity, so its role cannot be changed', p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    IF p_role = 'Advisor' THEN
        SELECT EXISTS (
                   SELECT 1
                     FROM auth.users AS u
                    WHERE u.id = v_auth_user_id
                      AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb
               ) AND v_current_active
          INTO v_target_is_durable_admin;

        IF v_target_is_durable_admin THEN
            SELECT count(*)::integer
              INTO v_membership
              FROM public.advisor AS a
              JOIN auth.users AS u ON u.id = a.auth_user_id
             WHERE a.is_active = true
               AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb;

            IF v_membership <= 1 THEN
                RAISE EXCEPTION
                    'cannot demote the last active, bound durable administrator; at least one effective Admin must remain'
                    USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    UPDATE auth.users AS u
       SET raw_app_meta_data = jsonb_set(
           coalesce(u.raw_app_meta_data, '{}'::jsonb),
           '{ocf_admin}',
           to_jsonb(p_role = 'Admin')
       )
     WHERE u.id = v_auth_user_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
        RAISE EXCEPTION 'advisor % is not bound to an existing Auth identity', p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config('ocf.suppress_advisor_audit', 'on', true);

    UPDATE public.advisor AS a
       SET role = p_role
     WHERE a.advisor_id = p_advisor_id
     RETURNING a.row_version INTO v_new_version;

    PERFORM pg_catalog.set_config('ocf.suppress_advisor_audit', '', true);

    IF v_current_role IS DISTINCT FROM p_role THEN
        v_old_values := jsonb_build_object('role', v_current_role);
        v_new_values := jsonb_build_object('role', p_role);

        INSERT INTO public.audit_event (
            entity_type, entity_id, action, actor_advisor_id,
            actor_name_snapshot, old_values, new_values, changes, reason, origin
        )
        VALUES (
            'advisor', p_advisor_id, 'role_changed', p_actor_id,
            v_actor_name, v_old_values, v_new_values,
            jsonb_build_object(
                'role', jsonb_build_object('old', v_current_role, 'new', p_role)
            ),
            p_reason, 'user'
        );
    END IF;

    RETURN QUERY
    SELECT p_advisor_id, p_role, v_auth_user_id, v_new_version;
END;
$$;

REVOKE ALL ON FUNCTION public.set_advisor_role(integer, text, text, integer, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_advisor_role(integer, text, text, integer, integer)
    TO service_role;

COMMENT ON FUNCTION public.set_advisor_role(integer, text, text, integer, integer) IS
    'ATOMIC trusted role change (service-role only) with an expected target version. Requires a non-blank reason and a server-supplied actor revalidated under the shared membership advisory lock. Enforces the last-durable-Admin invariant, rejects a stale target version with PT409 BEFORE any claim/display change, then atomically sets auth.users.raw_app_meta_data.ocf_admin AND public.advisor.role. The display-role write increments the advisor row_version exactly once; the advisor audit trigger is suppressed and exactly one explicit role_changed event is written. EXECUTE pinned to service_role only.';


-- ---------------------------------------------------------------------------
-- 4c. public.lifecycle_transition (versioned)
--
-- Adds the target's expected version to every branch. The comparison happens
-- after the target row lock and BEFORE any state change; a no-op transition
-- still returns the unchanged version.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.lifecycle_transition(text, text, integer, text);

CREATE OR REPLACE FUNCTION public.lifecycle_transition(
    p_entity text,
    p_action text,
    p_entity_id integer,
    p_reason text,
    p_expected_version integer
)
RETURNS TABLE (
    entity text,
    entity_id integer,
    action text,
    applied boolean,
    archived_at timestamptz,
    is_active boolean,
    row_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_bound_advisor_active boolean;
    v_current_archived_at timestamptz;
    v_current_is_active boolean;
    v_current_version integer;
    v_target_auth_user_id uuid;
    v_target_is_durable_admin boolean;
    v_membership integer;
    v_lock_key constant bigint :=
        pg_catalog.hashtextextended('ocf.advisor_admin_membership', 0);
BEGIN
    IF p_entity IS NULL OR p_action IS NULL OR p_entity_id IS NULL
       OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'lifecycle_transition requires entity, action, entity_id, and an expected version'
            USING ERRCODE = '22023';
    END IF;

    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'lifecycle_transition requires a non-blank reason'
            USING ERRCODE = '22023';
    END IF;

    IF p_entity = 'advisor' AND p_action = 'deactivate' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);
    END IF;

    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'lifecycle transitions require an authenticated administrator session'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_ocf_admin() THEN
        RAISE EXCEPTION 'only an administrator (Auth app_metadata ocf_admin=true) may perform lifecycle transitions'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.is_active
      INTO v_bound_advisor_active
      FROM public.advisor a
     WHERE a.auth_user_id = v_actor
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'lifecycle transitions require an advisor row bound to the authenticated session (advisor.auth_user_id); no binding found'
            USING ERRCODE = '42501';
    END IF;

    IF NOT v_bound_advisor_active THEN
        RAISE EXCEPTION 'lifecycle transitions require the session''s bound advisor to be ACTIVE; a deactivated administrator cannot perform lifecycle transitions (including reactivating their own advisor row)'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.set_config('ocf.audit_reason', p_reason, true);

    IF p_entity = 'student' THEN
        IF p_action NOT IN ('archive', 'restore') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for student (expected archive or restore)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT s.archived_at, s.row_version
          INTO v_current_archived_at, v_current_version
          FROM public.student s
         WHERE s.student_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'student % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        IF v_current_version IS DISTINCT FROM p_expected_version THEN
            RAISE EXCEPTION 'the student was changed by another session; refresh and review the latest data before saving'
                USING ERRCODE = 'PT409';
        END IF;

        applied := (p_action = 'archive' AND v_current_archived_at IS NULL)
                OR (p_action = 'restore' AND v_current_archived_at IS NOT NULL);

        IF applied THEN
            UPDATE public.student AS s
               SET archived_at = CASE WHEN p_action = 'archive' THEN now() ELSE NULL END
             WHERE s.student_id = p_entity_id
             RETURNING s.archived_at, s.row_version
                  INTO v_current_archived_at, v_current_version;
        END IF;

        entity := 'student';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := v_current_archived_at;
        is_active := NULL;
        row_version := v_current_version;
        RETURN NEXT;
        RETURN;
    END IF;

    IF p_entity = 'fellowship' THEN
        IF p_action NOT IN ('archive', 'restore') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for fellowship (expected archive or restore)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT f.archived_at, f.row_version
          INTO v_current_archived_at, v_current_version
          FROM public.fellowship f
         WHERE f.fellowship_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'fellowship % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        IF v_current_version IS DISTINCT FROM p_expected_version THEN
            RAISE EXCEPTION 'the fellowship was changed by another session; refresh and review the latest data before saving'
                USING ERRCODE = 'PT409';
        END IF;

        applied := (p_action = 'archive' AND v_current_archived_at IS NULL)
                OR (p_action = 'restore' AND v_current_archived_at IS NOT NULL);

        IF applied THEN
            UPDATE public.fellowship AS f
               SET archived_at = CASE WHEN p_action = 'archive' THEN now() ELSE NULL END
             WHERE f.fellowship_id = p_entity_id
             RETURNING f.archived_at, f.row_version
                  INTO v_current_archived_at, v_current_version;
        END IF;

        entity := 'fellowship';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := v_current_archived_at;
        is_active := NULL;
        row_version := v_current_version;
        RETURN NEXT;
        RETURN;
    END IF;

    IF p_entity = 'advisor' THEN
        IF p_action NOT IN ('deactivate', 'reactivate') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for advisor (expected deactivate or reactivate)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT a.is_active, a.auth_user_id, a.row_version
          INTO v_current_is_active, v_target_auth_user_id, v_current_version
          FROM public.advisor a
         WHERE a.advisor_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'advisor % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        IF v_current_version IS DISTINCT FROM p_expected_version THEN
            RAISE EXCEPTION 'the advisor was changed by another session; refresh and review the latest data before saving'
                USING ERRCODE = 'PT409';
        END IF;

        IF p_action = 'deactivate' AND v_current_is_active
           AND v_target_auth_user_id = v_actor THEN
            RAISE EXCEPTION
                'an administrator cannot deactivate their own active advisor account (it would immediately invalidate their session); another administrator must deactivate it'
                USING ERRCODE = '42501';
        END IF;

        IF p_action = 'deactivate' AND v_current_is_active THEN
            SELECT EXISTS (
                       SELECT 1
                         FROM auth.users AS u
                        WHERE u.id = v_target_auth_user_id
                          AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb
                   )
              INTO v_target_is_durable_admin;

            IF v_target_is_durable_admin THEN
                SELECT count(*)::integer
                  INTO v_membership
                  FROM public.advisor AS a
                  JOIN auth.users AS u ON u.id = a.auth_user_id
                 WHERE a.is_active = true
                   AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb;

                IF v_membership <= 1 THEN
                    RAISE EXCEPTION
                        'cannot deactivate the last active, bound durable administrator; at least one effective Admin must remain'
                        USING ERRCODE = '42501';
                END IF;
            END IF;
        END IF;

        applied := (p_action = 'deactivate' AND v_current_is_active)
                OR (p_action = 'reactivate' AND NOT v_current_is_active);

        IF applied THEN
            UPDATE public.advisor AS a
               SET is_active = (p_action = 'reactivate')
             WHERE a.advisor_id = p_entity_id
             RETURNING a.is_active, a.row_version
                  INTO v_current_is_active, v_current_version;
        END IF;

        entity := 'advisor';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := NULL;
        is_active := v_current_is_active;
        row_version := v_current_version;
        RETURN NEXT;
        RETURN;
    END IF;

    RAISE EXCEPTION 'unsupported lifecycle entity % (expected student, fellowship, or advisor)', p_entity
        USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.lifecycle_transition(text, text, integer, text, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lifecycle_transition(text, text, integer, text, integer)
    TO authenticated;

COMMENT ON FUNCTION public.lifecycle_transition(text, text, integer, text, integer) IS
    'Admin-only idempotent lifecycle RPC with a REQUIRED non-blank reason and expected target version. Requires BOTH the immutable Auth app_metadata ocf_admin=true claim AND a current ACTIVE bound advisor identity (actor derived from auth.uid() only). Whitelisted transitions: student/fellowship archive|restore and advisor deactivate|reactivate. PT409 on a stale target version (no change, no version bump, no audit event). Advisor deactivation and role demotion share a fixed advisory lock and enforce at-least-one-durable-active-Admin. Self-deactivation of the caller''s own active advisor row is rejected. Returns the resulting state and row_version.';


-- ---------------------------------------------------------------------------
-- 4d. public.provision_advisor (insert-only; returns version 1)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.provision_advisor(integer, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.provision_advisor(
    p_actor_id integer,
    p_advisor_name text,
    p_email text,
    p_auth_user_id uuid,
    p_role text
)
RETURNS TABLE (advisor_id integer, role text, auth_user_id uuid, row_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_new_advisor_id integer;
    v_new_version integer;
BEGIN
    IF p_role IS NULL OR p_role NOT IN ('Admin', 'Advisor') THEN
        RAISE EXCEPTION 'provision_advisor role must be Admin or Advisor'
            USING ERRCODE = '22023';
    END IF;
    IF p_advisor_name IS NULL OR btrim(p_advisor_name) = '' THEN
        RAISE EXCEPTION 'provision_advisor requires a non-blank advisor_name'
            USING ERRCODE = '22023';
    END IF;
    IF p_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'provision_advisor requires a bound auth_user_id'
            USING ERRCODE = '22023';
    END IF;

    PERFORM private.set_audit_actor(p_actor_id);

    INSERT INTO public.advisor AS a (
        advisor_name, email, auth_user_id, is_active, role
    )
    VALUES (
        p_advisor_name, p_email, p_auth_user_id, true, p_role
    )
    RETURNING a.advisor_id, a.row_version
         INTO v_new_advisor_id, v_new_version;

    RETURN QUERY
    SELECT v_new_advisor_id, p_role, p_auth_user_id, v_new_version;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_advisor(integer, text, text, uuid, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_advisor(integer, text, text, uuid, text)
    TO service_role;

COMMENT ON FUNCTION public.provision_advisor(integer, text, text, uuid, text) IS
    'Service-role-only trusted advisor creation: validates the server-derived initiating Admin as a durable effective Admin, sets transaction-local audit context, and INSERTs the bound advisor row in the SAME transaction so exactly one advisor/created audit event is attributed to that Admin. Insert-only: the created row starts at row_version 1 (returned). EXECUTE pinned to service_role only.';


-- ============================================================================
-- 5. Non-bypassable boundary: revoke direct authenticated UPDATE
--
-- The definer writers above are unaffected. SELECT and INSERT RLS remain.
-- ============================================================================
REVOKE UPDATE ON TABLE public.student     FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.fellowship  FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.application FROM PUBLIC, anon, authenticated;
REVOKE UPDATE ON TABLE public.advisor     FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "active_advisor_update_student"     ON public.student;
DROP POLICY IF EXISTS "active_advisor_update_fellowship"  ON public.fellowship;
DROP POLICY IF EXISTS "active_advisor_update_application" ON public.application;
DROP POLICY IF EXISTS "advisor_update_own_profile"        ON public.advisor;

-- ============================================================================
-- End of migration. Additive columns/triggers/functions plus a forward-only
-- least-privilege revoke. No existing business row is edited, deleted, or
-- reset, and no prior migration, policy, grant, or audit row is weakened.
-- ============================================================================
