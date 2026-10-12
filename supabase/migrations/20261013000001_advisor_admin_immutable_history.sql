-- ============================================================================
-- OCF Fellowship Management System — Advisor / Admin Immutable History
--
-- Forward-only, additive migration for the approved
-- `advisor-admin-immutable-history` design (AI-DLC). It extends the existing
-- immutable-audit core to advisor/admin operations instead of introducing a
-- second audit table or a second authorization system.
--
-- What this migration adds/replaces
-- -------------------------------------------------------------------------
--   1. A dedicated advisor audit trigger helper `private.audit_advisor_change`
--      with a strict POSITIVE field allowlist — only `advisor_name`, `email`,
--      `role`, and `is_active` ever enter a snapshot or diff. Binding,
--      authentication, credential, token, claim, service-role, login-time, and
--      role-lock data can never be audited. `last_login_at`-only changes are
--      technical-only and never create an event. Inserts are `created`;
--      allowlisted profile edits are `updated`; `is_active` transitions are
--      `deactivated`/`reactivated`; role changes are `role_changed`.
--
--   2. Transaction-scoped trusted actor context for service operations:
--      `private.set_audit_actor(p_actor_id)` validates that the supplied
--      server-derived advisor id is a current, ACTIVE, pre-bound advisor whose
--      DURABLE Auth metadata carries the strict JSON boolean
--      `raw_app_meta_data.ocf_admin = true` (the same durable authority the
--      last-Admin invariant uses — never the mutable display role and never a
--      possibly-stale JWT), then stores the verified actor id and frozen name
--      in transaction-local `ocf.audit_actor_*` settings. There is no
--      client-reachable actor parameter: the private helper has no client
--      EXECUTE grant, and the setters are reachable only from service-only
--      SECURITY DEFINER routines.
--
--   3. `public.provision_advisor(...)` — a service-role-only SECURITY DEFINER
--      routine that validates the trusted actor, establishes the
--      transaction-local actor context, and then INSERTs the advisor row in the
--      SAME transaction, so the advisor audit trigger writes exactly one
--      `created` event attributed to the initiating Admin (not System).
--      Existing cross-system Auth provisioning and compensation stay in the
--      server adapter; no distributed Auth/DB transaction is claimed.
--
--   4. `public.set_advisor_role(p_advisor_id, p_role, p_reason, p_actor_id)` —
--      replaces the 2-arg form (explicitly dropped). It requires a non-blank
--      reason, serializes membership-reducing transitions under a fixed
--      transaction advisory lock, validates the trusted actor ONLY while
--      holding that lock AND row-locking the actor's advisor row (so a
--      concurrent actor deactivation cannot race the validation), enforces
--      the at-least-one-durable-active-Admin invariant,
--      and atomically updates
--      `auth.users.raw_app_meta_data.ocf_admin` AND `public.advisor.role` in one
--      transaction. The advisor audit trigger is suppressed for that role write
--      and the routine emits exactly ONE explicit `role_changed` event carrying
--      the verified actor, frozen name, role diff, and reason — never a
--      duplicate `updated`/`role_changed` trigger event.
--
--   5. `public.lifecycle_transition(p_entity, p_action, p_entity_id,
--      p_reason)` — replaces the 3-arg form (explicitly dropped) with a
--      required non-blank reason. The actor stays database-derived from
--      `auth.uid()`; authorization stays claim + active-bound-advisor; student
--      and fellowship audit events receive the supplied reason through the
--      existing helper without expanding their allowlist; advisor
--      deactivate/reactivate is classified by the advisor helper; and advisor
--      deactivation is serialized with role demotion under the same advisory
--      lock with the at-least-one-durable-Admin check.
--
--   6. The existing `private.audit_current_state_change()` helper is
--      `CREATE OR REPLACE`d ONLY to read the transaction-local
--      `ocf.audit_reason` setting and populate `audit_event.reason`. Its
--      allowlists, actor/origin resolution, lifecycle classification, no-op
--      suppression, and security posture are preserved byte-for-byte.
--
--   7. A column-scoped invoker-security guard
--      (`trg_advisor_email_direct_write` / `guard_advisor_email_direct_write`)
--      that rejects direct authenticated UPDATEs of `advisor.email` with 42501,
--      so the email projection can never silently diverge from
--      `auth.users.email`. Service-role/DBA trusted provisioning may still set
--      it; no-op restatements pass; INSERT, role/lifecycle writes, and all
--      non-email column writes never fire it.
--
--   8. Decommissions the two legacy direct-write display-role RPCs
--      `public.fenced_write_advisor_role_display` and
--      `public.reconcile_advisor_role_display` (DROP; their EXECUTE grants are
--      explicitly revoked first and are removed with the functions). Both were
--      alternate, NON-atomic writers of `public.advisor.role` superseded by
--      `set_advisor_role`: they wrote only the mutable display projection
--      (never the durable Auth claim), carried no human actor or reason, and
--      performed no at-least-one-durable-active-Admin check, so a service-role
--      caller could land a claim/display mismatch or remove the last effective
--      Admin without a human-attributed audit event. The `advisor_role_lock`
--      table and the lease lifecycle/read-only primitives are preserved.
--
-- Preserved unchanged: Supabase Auth, one-time `auth_user_id` binding, the
-- `app_metadata.ocf_admin` + active-bound-advisor effective-Admin model, the
-- atomic role-change boundary, the lifecycle authorization boundary, direct
-- lifecycle/role/binding write guards, all RLS policies, all grants on
-- `audit_event`, all FKs (`NO ACTION`), and the legacy `advisor_role_lock`
-- table plus its lease `acquire`/`release` and read-only `verify`/`fenced-read`
-- primitives (still infrastructure-only and unaudited — they write no advisor
-- state). The two legacy direct-write display-role RPCs are dropped (item 8).
--
-- Security boundary: every new private helper is SECURITY DEFINER with
-- `SET search_path = ''` and fully schema-qualified references. The new
-- advisor email guard is deliberately SECURITY INVOKER (like the existing
-- role/lifecycle/one-time-bind guards) so its trust check reflects the real
-- session. Private helpers are revoked from PUBLIC/anon/authenticated with no
-- client EXECUTE grant.
-- `audit_event` remains read-only to product roles; no client path can write or
-- mutate history. No down migration is provided.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trusted actor validation + transaction-local audit context
--
--    `private.assert_durable_effective_admin` is the single source of truth for
--    "is this server-supplied advisor id a trusted actor?". It uses DURABLE
--    authority — an active, pre-bound advisor joined to `auth.users` whose
--    `raw_app_meta_data.ocf_admin` is the strict JSON boolean true — matching
--    `public.is_ocf_admin()`'s strictness and never consulting the mutable
--    display role. It returns the frozen display name (or raises 42501).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.assert_durable_effective_admin(
    p_advisor_id integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_name text;
BEGIN
    IF p_advisor_id IS NULL THEN
        RAISE EXCEPTION 'trusted actor advisor id is required'
            USING ERRCODE = '22023';
    END IF;

    -- Durable effective Admin: ACTIVE, pre-bound (auth_user_id non-null), and
    -- carrying the strict boolean Auth metadata claim. A string "true" claim,
    -- a missing/expired JWT, the mutable display role, and an unbound or
    -- inactive advisor are all rejected.
    SELECT a.advisor_name
      INTO v_actor_name
      FROM public.advisor AS a
      JOIN auth.users AS u ON u.id = a.auth_user_id
     WHERE a.advisor_id = p_advisor_id
       AND a.is_active = true
       AND a.auth_user_id IS NOT NULL
       AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'advisor % is not an active, bound durable administrator; trusted actor rejected',
            p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    RETURN v_actor_name;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_durable_effective_admin(integer)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.assert_durable_effective_admin(integer) IS
    'Internal trusted-actor validator: returns the frozen advisor_name only when the supplied advisor id is a current ACTIVE pre-bound advisor whose durable Auth metadata has the strict JSON boolean raw_app_meta_data.ocf_admin = true. Raises 42501 otherwise. Never consults the mutable display role or a possibly-stale JWT. Not callable by any client role.';

-- ---------------------------------------------------------------------------
--    Row-locked variant for serialized service mutations. Identical durable
--    effective-Admin semantics, but the advisor row is locked FOR UPDATE, so
--    once `set_advisor_role` holds the shared membership advisory lock, no
--    concurrent write — a lifecycle deactivation, a role demotion, or a direct
--    technical write to is_active/role/binding — can change the validated actor
--    before the state/audit write. Callers MUST hold `ocf.advisor_admin_membership`
--    advisory lock first so this row lock cannot invert order with the actor
--    row lock taken by `lifecycle_transition`'s authorization step.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.lock_and_assert_durable_effective_admin(
    p_advisor_id integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_name text;
BEGIN
    IF p_advisor_id IS NULL THEN
        RAISE EXCEPTION 'trusted actor advisor id is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT a.advisor_name
      INTO v_actor_name
      FROM public.advisor AS a
      JOIN auth.users AS u ON u.id = a.auth_user_id
     WHERE a.advisor_id = p_advisor_id
       AND a.is_active = true
       AND a.auth_user_id IS NOT NULL
       AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'advisor % is not an active, bound durable administrator; trusted actor rejected',
            p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    RETURN v_actor_name;
END;
$$;

REVOKE ALL ON FUNCTION private.lock_and_assert_durable_effective_admin(integer)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.lock_and_assert_durable_effective_admin(integer) IS
    'Internal trusted-actor validator with FOR UPDATE row lock: same durable effective-Admin semantics as assert_durable_effective_admin, but locks the actor''s advisor row so the validated actor cannot become inactive or non-effective between validation and the service mutation. Must be called only while holding the ocf.advisor_admin_membership advisory lock. Not callable by any client role.';

-- ---------------------------------------------------------------------------
--    `private.set_audit_actor` validates the actor and stores the verified id
--    and frozen name as transaction-local settings. Because `set_config(..., 
--    true)` is transaction-local, the context can never leak across requests or
--    sessions. It has no client EXECUTE grant and is reachable only from the
--    service-only SECURITY DEFINER routines below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.set_audit_actor(
    p_actor_id integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_name text;
BEGIN
    v_actor_name := private.assert_durable_effective_admin(p_actor_id);
    PERFORM pg_catalog.set_config('ocf.audit_actor_id', p_actor_id::text, true);
    PERFORM pg_catalog.set_config('ocf.audit_actor_name', v_actor_name, true);
END;
$$;

REVOKE ALL ON FUNCTION private.set_audit_actor(integer)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.set_audit_actor(integer) IS
    'Internal transaction-local trusted actor context setter. Validates the advisor id as a durable active, bound, Auth-metadata effective Admin and stores the verified id + frozen name for the current transaction only. No client EXECUTE grant; reachable only from service-only SECURITY DEFINER routines.';

-- ---------------------------------------------------------------------------
-- 2. Advisor audit trigger helper + trigger
--
--    Snapshot/diff allowlist is EXACTLY `advisor_name`, `email`, `role`,
--    `is_active`. Everything else (auth_user_id, last_login_at, timestamps,
--    claims, tokens, credentials, locks, future columns) is structurally
--    excluded. Actor resolution:
--      * non-null auth.uid() -> exactly one active bound advisor (fail closed
--        42501 if it does not resolve uniquely); origin 'user';
--      * otherwise a verified transaction-local trusted actor (service
--        operation) -> frozen id/name; origin 'user';
--      * otherwise -> System/system (technical writes, e.g. trusted seeding).
--    The trusted context is re-validated here as defense in depth.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.audit_advisor_change()
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
    v_action text;
    v_old_values jsonb;
    v_new_values jsonb;
    v_changes jsonb;
    v_reason text;
    v_key text;
    -- Explicit positive allowlist; technical/sensitive columns never appear.
    v_advisor_keys constant text[] := ARRAY[
        'advisor_name', 'email', 'role', 'is_active'
    ];
BEGIN
    -- The trusted explicit role-change RPC suppresses this trigger and writes
    -- its own single, reason-bearing event; never duplicate it here.
    IF coalesce(current_setting('ocf.suppress_advisor_audit', true), '') = 'on' THEN
        RETURN NULL;
    END IF;

    -- Defense in depth: this helper is wired only to public.advisor.
    IF TG_TABLE_NAME <> 'advisor' THEN
        RETURN NULL;
    END IF;

    v_reason := nullif(current_setting('ocf.audit_reason', true), '');
    v_actor := auth.uid();

    -- -----------------------------------------------------------------------
    -- Actor resolution and origin classification.
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
            -- Re-validate the transaction-local actor (defense in depth): only a
            -- current, active, bound durable Admin may be attributed.
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

    IF TG_OP = 'INSERT' THEN
        v_action := 'created';
        v_old_values := NULL;
        v_changes := NULL;
        v_new_values := jsonb_build_object(
            'advisor_name', NEW.advisor_name,
            'email', NEW.email,
            'role', NEW.role,
            'is_active', NEW.is_active
        );
    ELSE
        v_old_values := jsonb_build_object(
            'advisor_name', OLD.advisor_name,
            'email', OLD.email,
            'role', OLD.role,
            'is_active', OLD.is_active
        );
        v_new_values := jsonb_build_object(
            'advisor_name', NEW.advisor_name,
            'email', NEW.email,
            'role', NEW.role,
            'is_active', NEW.is_active
        );

        -- Diff only allowlisted fields under IS DISTINCT FROM.
        v_changes := '{}'::jsonb;
        FOR v_key IN SELECT unnest(v_advisor_keys) LOOP
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

        -- A no-op or technical-only change (e.g. last_login_at) records nothing.
        IF v_changes = '{}'::jsonb THEN
            RETURN NULL;
        END IF;

        -- Lifecycle classification first (single canonical event), then role.
        IF v_old_values -> 'is_active' IS DISTINCT FROM v_new_values -> 'is_active' THEN
            IF (v_new_values ->> 'is_active')::boolean THEN
                v_action := 'reactivated';
            ELSE
                v_action := 'deactivated';
            END IF;
        ELSIF OLD.role IS DISTINCT FROM NEW.role THEN
            v_action := 'role_changed';
        ELSE
            v_action := 'updated';
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
        reason,
        origin
    )
    VALUES (
        'advisor',
        NEW.advisor_id,
        v_action,
        v_actor_advisor_id,
        v_actor_name,
        v_old_values,
        v_new_values,
        v_changes,
        v_reason,
        v_origin
    );

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.audit_advisor_change()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.audit_advisor_change() IS
    'Internal SECURITY DEFINER advisor audit trigger helper: writes exactly one immutable public.audit_event per advisor INSERT or meaningful UPDATE inside the source transaction. Positive allowlist (advisor_name, email, role, is_active only), no-op/last_login_at suppression, lifecycle deactivate/reactivate + role_changed + created/updated classification, transaction-local trusted actor support, and System fallback. Not callable by any client role and not exposed as a Data API RPC.';

DROP TRIGGER IF EXISTS trg_audit_advisor_current_state ON public.advisor;

CREATE TRIGGER trg_audit_advisor_current_state
    AFTER INSERT OR UPDATE ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION private.audit_advisor_change();

COMMENT ON TRIGGER trg_audit_advisor_current_state ON public.advisor IS
    'Writes one immutable audit event for every advisor INSERT or meaningful UPDATE (lifecycle deactivate/reactivate classified accordingly; role changes classified as role_changed unless the trusted explicit role RPC suppresses and writes its own event).';

-- ---------------------------------------------------------------------------
-- 3. Reason-aware current-state helper (student/fellowship/application)
--
--    CREATE OR REPLACE of the immutable-audit helper. The ONLY change is that
--    the transaction-local `ocf.audit_reason` setting (set by
--    lifecycle_transition) is read and written into `audit_event.reason`. The
--    allowlists, actor/origin resolution, lifecycle classification, and no-op
--    suppression are preserved byte-for-byte; the student/fellowship allowlist
--    is NOT expanded.
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
    v_reason text;
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
    -- Human-supplied lifecycle reason (transaction-local, optional elsewhere).
    v_reason := nullif(current_setting('ocf.audit_reason', true), '');

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
        v_old_values,
        v_new_values,
        v_changes,
        v_reason,
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
    'Internal SECURITY DEFINER trigger helper: writes exactly one immutable public.audit_event per INSERT or meaningful UPDATE of student/fellowship/application inside the source transaction. Explicit snapshot/diff whitelists, unique active-advisor actor resolution (or System/system fallback), lifecycle archive/restore classification, no-op suppression, and (new) transaction-local lifecycle reason capture. Runs with empty search_path and fully qualified references. Not callable by any client role.';

-- ---------------------------------------------------------------------------
-- 4. set_advisor_role: actor + reason aware, membership-safe, single event
--
--    Replaces the 2-argument form. The old (integer, text) signature is
--    explicitly DROPPED so a caller can never bypass the required reason/actor
--    or the last-Admin invariant through the legacy arity. Service-role only.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_advisor_role(integer, text);

CREATE OR REPLACE FUNCTION public.set_advisor_role(
    p_advisor_id integer,
    p_role text,
    p_reason text,
    p_actor_id integer
)
RETURNS TABLE (advisor_id integer, role text, auth_user_id uuid)
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
    v_target_is_durable_admin boolean;
    v_membership integer;
    v_old_values jsonb;
    v_new_values jsonb;
    -- Fixed shared advisory-lock key for advisor durable-Admin membership.
    v_lock_key constant bigint :=
        pg_catalog.hashtextextended('ocf.advisor_admin_membership', 0);
BEGIN
    -- Strict role validation and mandatory non-blank human reason.
    IF p_role IS NULL OR p_role NOT IN ('Admin', 'Advisor') THEN
        RAISE EXCEPTION 'set_advisor_role role must be Admin or Advisor'
            USING ERRCODE = '22023';
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'set_advisor_role requires a non-blank reason'
            USING ERRCODE = '22023';
    END IF;

    -- Serialize membership-reducing transitions (role demotion and advisor
    -- deactivation share this key) before reading membership or locking the
    -- target, so competing final-Admin reductions cannot interleave.
    PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

    -- Validate the server-supplied actor AS a durable active, bound effective
    -- Admin AFTER the shared advisory lock is held and BEFORE any state or
    -- audit write. The validation ROW-LOCKS the actor's advisor row, so the
    -- actor cannot become inactive or demoted between this check and the
    -- mutation below: advisor deactivation and role demotion take this same
    -- membership lock, and the row lock additionally blocks direct technical
    -- writes to the actor row. Freeze the verified actor name for the event.
    v_actor_name := private.lock_and_assert_durable_effective_admin(p_actor_id);

    SELECT a.auth_user_id, a.role, a.is_active
      INTO v_auth_user_id, v_current_role, v_current_active
      FROM public.advisor AS a
     WHERE a.advisor_id = p_advisor_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'advisor % does not exist', p_advisor_id
            USING ERRCODE = 'P0002';
    END IF;

    -- No rebinding: a role change requires an already-bound advisor identity.
    IF v_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'advisor % is not bound to an Auth identity, so its role cannot be changed', p_advisor_id
            USING ERRCODE = '42501';
    END IF;

    -- At-least-one-durable-active-Admin invariant. Only a demotion can reduce
    -- membership; the target contributes exactly when it is ACTIVE and its
    -- durable Auth metadata carries the strict boolean admin claim. The mutable
    -- display role is never the authority.
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

    -- 1. Atomically set the trusted Auth claim (JSON boolean; jsonb_set
    --    preserves the rest of app_metadata, matching GoTrue's merge).
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

    -- 2. Suppress the advisor audit trigger, set the protected display role, and
    --    emit exactly ONE explicit role_changed event with the verified actor,
    --    frozen name, role diff, and reason. A no-op role restatement writes no
    --    event (nothing meaningful changed).
    PERFORM pg_catalog.set_config('ocf.suppress_advisor_audit', 'on', true);

    UPDATE public.advisor AS a
       SET role = p_role
     WHERE a.advisor_id = p_advisor_id;

    -- The suppression is transaction-local: reset it now so a legitimate
    -- advisor write later in the SAME transaction (e.g. a lifecycle
    -- deactivation) is never accidentally silenced. The explicit event below
    -- is written to audit_event, so resetting before it is safe.
    PERFORM pg_catalog.set_config('ocf.suppress_advisor_audit', '', true);

    IF v_current_role IS DISTINCT FROM p_role THEN
        v_old_values := jsonb_build_object('role', v_current_role);
        v_new_values := jsonb_build_object('role', p_role);

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
            origin
        )
        VALUES (
            'advisor',
            p_advisor_id,
            'role_changed',
            p_actor_id,
            v_actor_name,
            v_old_values,
            v_new_values,
            jsonb_build_object(
                'role',
                jsonb_build_object('old', v_current_role, 'new', p_role)
            ),
            p_reason,
            'user'
        );
    END IF;

    RETURN QUERY
    SELECT p_advisor_id, p_role, v_auth_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_advisor_role(integer, text, text, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_advisor_role(integer, text, text, integer)
    TO service_role;

COMMENT ON FUNCTION public.set_advisor_role(integer, text, text, integer) IS
    'ATOMIC trusted role change (service-role only): requires a non-blank reason and a server-supplied actor id that is revalidated under the shared membership advisory lock as a current active, bound durable effective Admin, with the actor''s advisor row locked so it cannot become inactive between validation and the mutation. Serializes membership-reducing transitions under a fixed advisory lock, rejects demoting the last active bound durable Admin, then in ONE transaction sets auth.users.raw_app_meta_data.ocf_admin AND public.advisor.role. The advisor audit trigger is suppressed and exactly one explicit role_changed event (verified actor, frozen name, role diff, reason) is written. Never rebinds, never touches is_active/history. EXECUTE pinned to service_role only — clients cannot call it.';

-- ---------------------------------------------------------------------------
-- 5. lifecycle_transition: required reason, database-derived actor, atomic
--    lifecycle audit, last-Admin serialization
--
--    Replaces the 3-argument form; the old (text, text, integer) signature is
--    explicitly DROPPED so the reason can never be bypassed. Actor identity is
--    still derived ONLY from auth.uid() — never accepted as a parameter.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.lifecycle_transition(text, text, integer);

CREATE OR REPLACE FUNCTION public.lifecycle_transition(
    p_entity text,
    p_action text,
    p_entity_id integer,
    p_reason text
)
RETURNS TABLE (
    entity text,
    entity_id integer,
    action text,
    applied boolean,
    archived_at timestamptz,
    is_active boolean
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
    v_target_auth_user_id uuid;
    v_target_is_durable_admin boolean;
    v_membership integer;
    -- Fixed shared advisory-lock key for advisor durable-Admin membership.
    v_lock_key constant bigint :=
        pg_catalog.hashtextextended('ocf.advisor_admin_membership', 0);
BEGIN
    -- Fail closed on missing input: the actor check below must never be
    -- reachable through a NULL that slides past the whitelist.
    IF p_entity IS NULL OR p_action IS NULL OR p_entity_id IS NULL THEN
        RAISE EXCEPTION 'lifecycle_transition requires entity, action, and entity_id'
            USING ERRCODE = '22023';
    END IF;

    -- Mandatory non-blank human reason for every lifecycle action.
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        RAISE EXCEPTION 'lifecycle_transition requires a non-blank reason'
            USING ERRCODE = '22023';
    END IF;

    -- Serialize advisor deactivation with role demotion BEFORE locking any
    -- advisor row, so all membership-reducing operations share a lock order
    -- (advisory -> row) and membership reads are race-free.
    IF p_entity = 'advisor' AND p_action = 'deactivate' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);
    END IF;

    -- The actor is the authenticated JWT subject only. A technical session has
    -- no auth.uid() and is rejected: lifecycle transitions must be
    -- attributable to a specific authenticated administrator.
    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'lifecycle transitions require an authenticated administrator session'
            USING ERRCODE = '42501';
    END IF;

    -- Authorization (1/2): the immutable Auth app_metadata claim ocf_admin=true.
    -- The mutable public.advisor.role column is NEVER consulted.
    IF NOT public.is_ocf_admin() THEN
        RAISE EXCEPTION 'only an administrator (Auth app_metadata ocf_admin=true) may perform lifecycle transitions'
            USING ERRCODE = '42501';
    END IF;

    -- Authorization (2/2): the caller must ALSO be the CURRENT, ACTIVE,
    -- pre-bound advisor identity. The actor's own advisor row is locked FOR
    -- UPDATE so a concurrent deactivation cannot race this check.
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

    -- Publish the human reason for the trigger helpers (transaction-local).
    PERFORM pg_catalog.set_config('ocf.audit_reason', p_reason, true);

    IF p_entity = 'student' THEN
        IF p_action NOT IN ('archive', 'restore') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for student (expected archive or restore)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT s.archived_at
          INTO v_current_archived_at
          FROM public.student s
         WHERE s.student_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'student % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        applied := (p_action = 'archive' AND v_current_archived_at IS NULL)
                OR (p_action = 'restore' AND v_current_archived_at IS NOT NULL);

        IF applied THEN
            UPDATE public.student AS s
               SET archived_at = CASE WHEN p_action = 'archive' THEN now() ELSE NULL END
             WHERE s.student_id = p_entity_id
             RETURNING s.archived_at INTO v_current_archived_at;
        END IF;

        entity := 'student';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := v_current_archived_at;
        is_active := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    IF p_entity = 'fellowship' THEN
        IF p_action NOT IN ('archive', 'restore') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for fellowship (expected archive or restore)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT f.archived_at
          INTO v_current_archived_at
          FROM public.fellowship f
         WHERE f.fellowship_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'fellowship % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        applied := (p_action = 'archive' AND v_current_archived_at IS NULL)
                OR (p_action = 'restore' AND v_current_archived_at IS NOT NULL);

        IF applied THEN
            UPDATE public.fellowship AS f
               SET archived_at = CASE WHEN p_action = 'archive' THEN now() ELSE NULL END
             WHERE f.fellowship_id = p_entity_id
             RETURNING f.archived_at INTO v_current_archived_at;
        END IF;

        entity := 'fellowship';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := v_current_archived_at;
        is_active := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    IF p_entity = 'advisor' THEN
        IF p_action NOT IN ('deactivate', 'reactivate') THEN
            RAISE EXCEPTION 'invalid lifecycle action % for advisor (expected deactivate or reactivate)', p_action
                USING ERRCODE = '22023';
        END IF;

        SELECT a.is_active, a.auth_user_id
          INTO v_current_is_active, v_target_auth_user_id
          FROM public.advisor a
         WHERE a.advisor_id = p_entity_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'advisor % does not exist', p_entity_id
                USING ERRCODE = 'P0002';
        END IF;

        -- SELF-DEACTIVATION GUARD (retained byte-for-byte).
        IF p_action = 'deactivate' AND v_current_is_active
           AND v_target_auth_user_id = v_actor THEN
            RAISE EXCEPTION
                'an administrator cannot deactivate their own active advisor account (it would immediately invalidate their session); another administrator must deactivate it'
                USING ERRCODE = '42501';
        END IF;

        -- At-least-one-durable-active-Admin invariant for a real deactivation.
        -- The target contributes exactly when it is ACTIVE and its durable Auth
        -- metadata carries the strict boolean admin claim. The advisory lock
        -- (acquired above) serializes competing final-Admin reductions.
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
             RETURNING a.is_active INTO v_current_is_active;
        END IF;

        entity := 'advisor';
        entity_id := p_entity_id;
        action := p_action;
        archived_at := NULL;
        is_active := v_current_is_active;
        RETURN NEXT;
        RETURN;
    END IF;

    RAISE EXCEPTION 'unsupported lifecycle entity % (expected student, fellowship, or advisor)', p_entity
        USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.lifecycle_transition(text, text, integer, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lifecycle_transition(text, text, integer, text)
    TO authenticated;

COMMENT ON FUNCTION public.lifecycle_transition(text, text, integer, text) IS
    'Admin-only idempotent lifecycle RPC with a REQUIRED non-blank reason. Requires BOTH the immutable Auth app_metadata ocf_admin=true claim AND a current ACTIVE bound advisor identity (actor derived from auth.uid() only, never a parameter). Whitelisted transitions: student/fellowship archive|restore and advisor deactivate|reactivate. Student/fellowship events receive the supplied reason via the current-state helper; advisor transitions are classified by the advisor helper. Advisor deactivation and role demotion share a fixed advisory lock and enforce at-least-one-durable-active-Admin. Self-deactivation of the caller''s own active advisor row is rejected.';

-- ---------------------------------------------------------------------------
-- 6. provision_advisor: trusted, audited advisor creation
--
--    Service-role-only SECURITY DEFINER routine that validates the
--    server-derived initiating Admin, sets transaction-local audit context, and
--    INSERTs the advisor row in the SAME transaction. The advisor audit trigger
--    therefore writes exactly one `created` event attributed to that Admin.
--    Auth identity creation/claim setting and their compensation stay in the
--    server adapter; this is not a distributed Auth/DB transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_advisor(
    p_actor_id integer,
    p_advisor_name text,
    p_email text,
    p_auth_user_id uuid,
    p_role text
)
RETURNS TABLE (advisor_id integer, role text, auth_user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_new_advisor_id integer;
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

    -- Validate the trusted actor and publish transaction-local context BEFORE
    -- the insert so the audit trigger attributes the created event correctly.
    PERFORM private.set_audit_actor(p_actor_id);

    INSERT INTO public.advisor AS a (
        advisor_name,
        email,
        auth_user_id,
        is_active,
        role
    )
    VALUES (
        p_advisor_name,
        p_email,
        p_auth_user_id,
        true,
        p_role
    )
    RETURNING a.advisor_id INTO v_new_advisor_id;

    RETURN QUERY
    SELECT v_new_advisor_id, p_role, p_auth_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_advisor(integer, text, text, uuid, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_advisor(integer, text, text, uuid, text)
    TO service_role;

COMMENT ON FUNCTION public.provision_advisor(integer, text, text, uuid, text) IS
    'Service-role-only trusted advisor creation: validates the server-derived initiating Admin as a durable effective Admin, sets transaction-local audit context, and INSERTs the bound advisor row in the SAME transaction so exactly one advisor/created audit event is attributed to that Admin. Auth identity creation/claim and compensation remain in the server adapter. EXECUTE pinned to service_role only — no client can call it.';

-- ---------------------------------------------------------------------------
-- 7. Direct-write guard on advisor.email (Auth-identity consistency)
--
--    `advisor.email` is an Auth-identity projection: it is the login/display
--    email that an administrator provisions through the trusted server path
--    (where it is written to the Auth identity AND the advisor row together).
--    Allowing an authenticated/browser session to UPDATE `advisor.email`
--    directly would silently diverge the projection from `auth.users.email`
--    (an authenticated client cannot update `auth.users`), so this
--    column-scoped invoker-security guard rejects every non-trusted email
--    change fail-closed with 42501. Same trust model as the existing one-time
--    `auth_user_id`, `is_active`, and `role` guards:
--
--      - SECURITY INVOKER (never DEFINER): current_user/session_user reflect
--        the real executing session, so the trust check cannot be bypassed by
--        definer privilege;
--      - trusted writers are the server-only provisioning adapter
--        (service_role), a legacy service-role JWT session, and a DBA/migration
--        session (session_user/current_user = 'postgres'). Service-role trusted
--        provisioning is preserved;
--      - a no-op restatement (`NEW.email IS NOT DISTINCT FROM OLD.email`) never
--        diverges and passes through, so ordinary profile updates that happen
--        to echo the current email are unaffected;
--      - the trigger is `BEFORE UPDATE OF email` only: advisor INSERT (the
--        one-time-bind/provisioning creation path), role/lifecycle writes, and
--        updates to any other column never fire it, so all existing direct-
--        write protections and trusted provisioning flows are untouched.
--
--    Trigger functions get EXECUTE revoked from PUBLIC/anon/authenticated and
--    pinned to service_role so the ACL stays non-empty (a default ACL would
--    grant EXECUTE to PUBLIC). The trigger mechanism invokes it without any
--    EXECUTE grant; direct RPC invocation is harmless (it requires NEW/OLD).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_advisor_email_direct_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- Trusted technical sessions: the server-only provisioning adapter
    -- (service_role) and DBA/migration sessions may set the email projection.
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    -- UPDATE no-op: the value did not change, so it cannot diverge from the
    -- Auth identity. Pass through so ordinary updates that restate the current
    -- email (or the profile path echoing the read-only field) are unaffected.
    IF NEW.email IS NOT DISTINCT FROM OLD.email THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'advisor.email is Auth-identity bound: it may be changed only by trusted server-side provisioning (service_role/DBA) so it can never diverge from auth.users.email; an authenticated session cannot edit the advisor email projection'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advisor_email_direct_write()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_advisor_email_direct_write()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advisor_email_direct_write ON public.advisor;

CREATE TRIGGER trg_advisor_email_direct_write
    BEFORE UPDATE OF email ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advisor_email_direct_write();

COMMENT ON FUNCTION public.guard_advisor_email_direct_write() IS
    'Non-RPC invoker-security guard: advisor.email is the Auth-identity login/display projection and may be changed only by trusted server-side provisioning (service_role/DBA), so it can never silently diverge from auth.users.email. Authenticated/browser email changes are rejected with 42501; no-op restatements pass through; INSERT and all non-email column writes never fire it.';

-- ---------------------------------------------------------------------------
-- 8. Decommission the legacy direct-write display-role RPCs
--
--    `public.fenced_write_advisor_role_display(integer, text, text)` and
--    `public.reconcile_advisor_role_display(integer, text)` are the remaining
--    alternate writers of `public.advisor.role`. They predate `set_advisor_role`
--    and are NOT part of the atomic, human-attributed role-change boundary:
--
--      * they write ONLY the mutable display projection and never
--        `auth.users.raw_app_meta_data.ocf_admin`, so a service-role caller
--        could land a display role that disagrees with the durable Auth claim —
--        exactly the mismatch `set_advisor_role` makes impossible;
--      * they accept no human actor and no reason, so any write through them
--        would bypass human attribution and the mandatory-reason
--        `role_changed` audit event;
--      * they perform no at-least-one-durable-active-Admin check, so a
--        service-role caller could demote the last effective Admin.
--
--    Dropping them at the database boundary removes those alternate write
--    paths entirely; `set_advisor_role` (above) stays the single atomic writer
--    of the display role and is NOT weakened. Each function was
--    service_role-pinned; the explicit REVOKEs below document the empty-ACL
--    posture (a DROP would remove the grants anyway, and this keeps the ACL
--    non-reachable even if the DROP were ever skipped).
--
--    PRESERVED UNTOUCHED: the `public.advisor_role_lock` table and the lease
--    lifecycle RPCs `public.acquire_advisor_role_lock` /
--    `public.release_advisor_role_lock`, plus the read-only
--    `public.verify_advisor_role_lock` /
--    `public.fenced_read_advisor_role_display`. None of these write advisor
--    state, so they provide no direct display-role or claim write path.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fenced_write_advisor_role_display(integer, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_advisor_role_display(integer, text)
    FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.fenced_write_advisor_role_display(integer, text, text);
DROP FUNCTION IF EXISTS public.reconcile_advisor_role_display(integer, text);

-- ============================================================================
-- End of migration. Additive/replacement/decommission-only; no existing
-- business row is edited, deleted, or reset. Forward-only.
-- ============================================================================
