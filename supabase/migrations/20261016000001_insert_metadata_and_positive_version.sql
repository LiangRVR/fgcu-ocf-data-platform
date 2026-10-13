-- ============================================================================
-- OCF Fellowship Management System — Insert metadata + positive expected version
--
-- Forward-only, additive/replacement migration closing two independent-review
-- database findings on the `historical-audit-timeline` change:
--
--   1. FORGED INSERT METADATA. The four current-state tables carry
--      `row_version integer NOT NULL DEFAULT 1` and
--      `updated_at timestamptz NOT NULL DEFAULT now()`, but a DEFAULT only
--      applies when a column is omitted. A caller (an authenticated INSERT on
--      student/fellowship/application, or a trusted/service-role INSERT) could
--      therefore supply an arbitrary `row_version` (e.g. 999) or a forged
--      `updated_at` and poison the optimistic-concurrency metadata. This
--      migration makes the version/timestamp DB-authored on EVERY insert by
--      extending the existing BEFORE UPDATE trigger helper to also handle
--      INSERT (`row_version := 1`, `updated_at := now()`) and re-creating the
--      four triggers as BEFORE INSERT OR UPDATE. Supplied values are always
--      overridden.
--
--   2. INCONSISTENT EXPECTED-VERSION VALIDATION. The protected existing-row
--      writers required `p_expected_version` to be non-NULL but accepted 0 and
--      negative values, which could only ever produce a stale `PT409` instead
--      of a malformed-input `22023`. A single internal helper
--      (`private.assert_expected_version`) now enforces `p_expected_version >= 1`
--      and raises `22023`, and it is called first by every protected
--      existing-row writer — the four entity writers, both advisor-profile
--      paths, the trusted role change, and the lifecycle transition. The seven
--      public function bodies are otherwise byte-for-byte identical to
--      migration 20261015000001 (the helper call is the only added statement),
--      so all authorization, locking, re-link, last-Admin, audit and stale
--      `PT409` behavior is preserved unchanged.
--
-- Preserved unchanged: the semantic one-increment/no-op UPDATE behavior, the
-- audit allowlists and exclusions, the revoked direct authenticated UPDATE
-- boundary, every ACL/RLS policy, the immutable audit surface, and all
-- unrelated working-tree changes. Forward-only; no existing business row,
-- policy, grant, or audit row is edited, deleted, or reset. No down migration.
-- ============================================================================


-- ============================================================================
-- 1. DB-authored insert metadata (override any supplied value)
--
-- The function is CREATE OR REPLACE'd with an INSERT branch; the UPDATE branch
-- (semantic allowlist, one increment, no-op preservation) is byte-for-byte the
-- migration 20261015000001 body. The triggers are re-created as
-- BEFORE INSERT OR UPDATE. SECURITY INVOKER (mutates only NEW); client EXECUTE
-- stays revoked.
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
    -- DB-authored metadata on EVERY insert: override any supplied value.
    IF TG_OP = 'INSERT' THEN
        NEW.row_version := 1;
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

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
    'Internal BEFORE INSERT OR UPDATE trigger: on INSERT forces DB-authored row_version = 1 and updated_at = now() (overriding any supplied value); on UPDATE increments row_version and stamps updated_at exactly once for a meaningful business/lifecycle change on student/fellowship/application/advisor, preserving both for a no-op or technical-only restatement. Version/timestamp columns never enter an audit snapshot/diff. Not callable by any client role.';

DROP TRIGGER IF EXISTS trg_student_current_state_version ON public.student;
CREATE TRIGGER trg_student_current_state_version
    BEFORE INSERT OR UPDATE ON public.student
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_fellowship_current_state_version ON public.fellowship;
CREATE TRIGGER trg_fellowship_current_state_version
    BEFORE INSERT OR UPDATE ON public.fellowship
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_application_current_state_version ON public.application;
CREATE TRIGGER trg_application_current_state_version
    BEFORE INSERT OR UPDATE ON public.application
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();

DROP TRIGGER IF EXISTS trg_advisor_current_state_version ON public.advisor;
CREATE TRIGGER trg_advisor_current_state_version
    BEFORE INSERT OR UPDATE ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION private.set_current_state_row_version();


-- ============================================================================
-- 2. Internal positive expected-version validator
--
-- Single source of truth for "p_expected_version is a well-formed optimistic
-- concurrency token": NULL, 0, and negative values are malformed input (22023),
-- distinct from a genuine stale conflict (PT409). SECURITY INVOKER, empty
-- search_path, no client EXECUTE grant; reachable only from the SECURITY
-- DEFINER writers (which run as the owner).
-- ============================================================================
CREATE OR REPLACE FUNCTION private.assert_expected_version(
    p_expected_version integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF p_expected_version IS NULL OR p_expected_version < 1 THEN
        RAISE EXCEPTION 'expected version must be a positive integer (>= 1)'
            USING ERRCODE = '22023';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_expected_version(integer)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.assert_expected_version(integer) IS
    'Internal validator: raises 22023 unless p_expected_version is a positive integer (>= 1). NULL/0/negative are malformed input, distinct from a stale PT409 conflict. Not callable by any client role.';


-- ============================================================================
-- 3. Protected existing-row writers: validate the expected version first
--
-- Each body is the migration 20261015000001 body with exactly one added
-- statement, `PERFORM private.assert_expected_version(p_expected_version);`,
-- as the first statement in BEGIN. CREATE OR REPLACE preserves ownership and
-- the existing ACLs; the REVOKE/GRANT pairs are restated for self-documentation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- update_student_profile
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
    PERFORM private.assert_expected_version(p_expected_version);
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

REVOKE ALL ON FUNCTION public.update_student_profile(integer, integer, text, text, boolean, text, text, numeric, text, boolean,
    integer, text, text, text, text, boolean, boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_student_profile(integer, integer, text, text, boolean, text, text, numeric, text, boolean,
    integer, text, text, text, text, boolean, boolean)
    TO authenticated;

-- ---------------------------------------------------------------------------
-- update_fellowship
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
    PERFORM private.assert_expected_version(p_expected_version);
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

-- ---------------------------------------------------------------------------
-- update_application
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
    PERFORM private.assert_expected_version(p_expected_version);
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

REVOKE ALL ON FUNCTION public.update_application(integer, integer, integer, integer, integer, text, text, boolean, boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_application(integer, integer, integer, integer, integer, text, text, boolean, boolean)
    TO authenticated;

-- ---------------------------------------------------------------------------
-- update_my_advisor_profile
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
    PERFORM private.assert_expected_version(p_expected_version);
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

-- ---------------------------------------------------------------------------
-- update_advisor_profile_name
-- ---------------------------------------------------------------------------
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
    PERFORM private.assert_expected_version(p_expected_version);
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

-- ---------------------------------------------------------------------------
-- set_advisor_role
-- ---------------------------------------------------------------------------
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
    PERFORM private.assert_expected_version(p_expected_version);
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

-- ---------------------------------------------------------------------------
-- lifecycle_transition
-- ---------------------------------------------------------------------------
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
    PERFORM private.assert_expected_version(p_expected_version);
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

-- ============================================================================
-- End of migration. Additive/replacement function + trigger definitions only;
-- no existing business row, column, policy, grant, or audit row is edited,
-- deleted, or reset. Forward-only.
-- ============================================================================
