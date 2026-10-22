-- ============================================================================
-- OCF Fellowship Management System — Lifecycle Review Remediation
--
-- Forward-only, additive migration. Independent review-blocker remediation for
-- AI-DLC change 2026-09-30-entity-lifecycle-archiving (review verdict FAIL):
--
--   Finding 1 — a deactivated administrator with a retained `ocf_admin` JWT
--   claim could call `public.lifecycle_transition` to reactivate their own
--   advisor row, defeating deactivation.
--
--     Remediation: `public.lifecycle_transition` now requires BOTH
--       (a) the trusted immutable Auth `app_metadata.ocf_admin = true` claim
--           (`public.is_ocf_admin()`, unchanged), AND
--       (b) a CURRENT, ACTIVE, pre-bound advisor identity: an `advisor` row
--           with `auth_user_id = auth.uid()` AND `is_active = true`.
--     A deactivated administrator (their bound advisor row is inactive) is
--     denied EVERY transition — including reactivating their own advisor row —
--     with 42501 before any row is touched. There is no email linking and no
--     self binding: the identity binding was performed by an administrator
--     during provisioning (admin-only `advisor.auth_user_id` pre-bind), and
--     this check only reads the existing binding. The actor's own advisor row
--     is locked FOR UPDATE so a concurrent deactivation cannot race the
--     authorization check. The existing self-deactivation guard (a second
--     administrator must deactivate an administrator's account) is retained.
--
--   Finding 2 — archived student/fellowship state was not enforced at the
--   database boundary for NEW operational child records: direct inserts or
--   updates could bypass the active-only UI selectors and link a fresh
--   application / advising meeting / Thursday attendance / award-history row
--   to an archived student or fellowship.
--
--     Remediation: BEFORE INSERT OR UPDATE OF <fk> column-scoped, invoker-
--     security triggers on the four operational child tables
--     (`application`, `advising_meeting`, `fellowship_thursday`,
--     `scholarship_history`) reject, fail-closed with 42501 for every
--     non-trusted session:
--       * INSERT of a child referencing an archived student/fellowship; and
--       * UPDATE that RE-LINKS a child to an archived student/fellowship
--         (NEW fk IS DISTINCT FROM OLD fk).
--     Preserved behavior:
--       * historical READS of children referencing archived parents are
--         untouched (no RLS change);
--       * UPDATEs that do not change the reference columns never fire the
--         trigger, so historical records that happen to point at an archived
--         parent stay editable;
--       * UPDATE that re-links a child from an archived parent to an ACTIVE
--         parent is always allowed;
--       * all non-archived workflows (children referencing active parents) are
--         unaffected;
--       * trusted technical sessions (`service_role` / DBA) are exempt so
--         synthetic-fixture seeding, cleanup, and trusted data fixes keep
--         working — the boundary targets browser/authenticated sessions.
--
-- Every FK definition is untouched: all foreign keys keep the default
-- NO ACTION semantics, and no archive/deactivate/restore action deletes,
-- nulls, or cascades historical relationships.
--
-- Forward-only, idempotent on re-apply: no existing migration, table, column,
-- row, FK, or RLS policy is edited, deleted, or reset. `lifecycle_transition`
-- is replaced in place (`CREATE OR REPLACE FUNCTION`, same signature, same
-- SECURITY DEFINER / empty search_path / ACL), and the new guard
-- functions/triggers are additive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lifecycle_transition: require an ACTIVE bound advisor in addition to the
--    trusted admin claim.
--
--    Same signature, SECURITY DEFINER, empty search_path, and return shape as
--    migration 20260930000005. The only behavioral change is the new
--    authorization gate described above; everything else (whitelist,
--    idempotence, FOR UPDATE target locking, self-deactivation guard,
--    fail-closed 22023/P0002 handling, actor derivation from auth.uid()) is
--    preserved byte-for-byte.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lifecycle_transition(
    p_entity text,
    p_action text,
    p_entity_id integer
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
BEGIN
    -- Fail closed on missing input: the actor check below must never be
    -- reachable through a NULL that slides past the whitelist.
    IF p_entity IS NULL OR p_action IS NULL OR p_entity_id IS NULL THEN
        RAISE EXCEPTION 'lifecycle_transition requires entity, action, and entity_id'
            USING ERRCODE = '22023';
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

    -- Authorization (2/2) — REVIEW REMEDIATION: the trusted admin claim alone
    -- is not enough. A deactivated administrator retains the JWT claim and
    -- could otherwise reactivate their own advisor row and defeat
    -- deactivation. The caller must ALSO be the CURRENT, ACTIVE, pre-bound
    -- advisor identity: an `advisor` row with `auth_user_id = auth.uid()`
    -- AND `is_active = true`. There is no email linking and no self binding —
    -- the binding was performed by an administrator during provisioning and
    -- this check only reads it. The actor's own advisor row is locked FOR
    -- UPDATE so a concurrent deactivation cannot race this authorization
    -- check.
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

        -- SELF-DEACTIVATION GUARD: the caller cannot deactivate the advisor
        -- row bound to their own session while it is active. That transition
        -- would immediately flip is_active_advisor() to false and strand the
        -- acting administrator (session denied by requireAdvisor/RLS), so a
        -- second administrator must perform the deactivation. Idempotent
        -- no-ops (already inactive) remain no-ops, and reactivating the
        -- caller's OWN row is only possible while the caller is themselves an
        -- ACTIVE bound advisor (the check above) — a deactivated
        -- administrator can never self-reactivate.
        IF p_action = 'deactivate' AND v_current_is_active
           AND v_target_auth_user_id = v_actor THEN
            RAISE EXCEPTION
                'an administrator cannot deactivate their own active advisor account (it would immediately invalidate their session); another administrator must deactivate it'
                USING ERRCODE = '42501';
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

-- Re-assert the ACL (CREATE OR REPLACE FUNCTION preserves grants, but keeping
-- the REVOKE/GRANT explicit makes the forward-only intent self-documenting).
REVOKE ALL ON FUNCTION public.lifecycle_transition(text, text, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lifecycle_transition(text, text, integer)
    TO authenticated;

COMMENT ON FUNCTION public.lifecycle_transition(text, text, integer) IS
    'Admin-only idempotent lifecycle RPC. Requires BOTH the immutable Auth app_metadata ocf_admin=true claim AND a current ACTIVE bound advisor identity (advisor.auth_user_id = auth.uid() AND is_active = true), so a deactivated administrator cannot reactivate their own advisor row. Whitelisted transitions: student/fellowship archive|restore (sets/clears archived_at := now()) and advisor deactivate|reactivate (sets is_active). Actor derived from auth.uid(); state stamped in the database; returns the resulting state. Self-deactivation of the caller''s own active advisor row is rejected.';

-- ---------------------------------------------------------------------------
-- 2. Archive-parent boundary on operational child records (REVIEW REMEDIATION
--    for Finding 2).
--
--    Column-scoped invoker-security triggers on the four operational child
--    tables that reference `student` and/or `fellowship`:
--
--      application            student_id, fellowship_id
--      advising_meeting       student_id
--      fellowship_thursday    student_id
--      scholarship_history    student_id, fellowship_id
--
--    Each trigger rejects — fail-closed, 42501, for every non-trusted
--    session — an INSERT whose referenced parent is archived, and an UPDATE
--    that re-links a child to an archived parent. Trusted technical sessions
--    (the SECURITY DEFINER lifecycle RPC, service_role, DBA postgres) are
--    exempt exactly like the migration 20260930000005 lifecycle guards.
--    Historical reads are never touched, non-reference updates never fire the
--    trigger (column-scoped UPDATE OF), and re-linking to an ACTIVE parent is
--    always allowed.
--
--    Trigger functions get EXECUTE revoked from PUBLIC/anon/authenticated and
--    pinned to service_role so the ACL stays non-empty (a default ACL would
--    grant EXECUTE to PUBLIC). The trigger mechanism invokes them without any
--    EXECUTE grant; direct RPC invocation is harmless (they require NEW/OLD).
-- ---------------------------------------------------------------------------

-- --- application (student_id, fellowship_id) ---
CREATE OR REPLACE FUNCTION public.guard_application_archive_parents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- Trusted technical sessions bypass the boundary (fixture seeding, cleanup,
    -- and trusted data fixes). This is the same exemption the lifecycle guard
    -- triggers use; the boundary targets browser/authenticated sessions.
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    -- INSERT: creating a NEW operational child that references an archived
    -- student or fellowship is a forged active-workflow link.
    IF TG_OP = 'INSERT' THEN
        IF NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create an application referencing archived student % (restore the student or choose an active student)',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        IF NEW.fellowship_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.fellowship f
                WHERE f.fellowship_id = NEW.fellowship_id
                  AND f.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create an application referencing archived fellowship % (restore the fellowship or choose an active fellowship)',
                NEW.fellowship_id
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    -- UPDATE: only a re-link that CHANGES the reference is a new operational
    -- reference. Unchanged references (historical records that keep pointing
    -- at an archived parent) pass through, and re-linking to an ACTIVE parent
    -- is always allowed.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.student_id IS DISTINCT FROM OLD.student_id
           AND NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link an application to archived student %',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        IF NEW.fellowship_id IS DISTINCT FROM OLD.fellowship_id
           AND NEW.fellowship_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.fellowship f
                WHERE f.fellowship_id = NEW.fellowship_id
                  AND f.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link an application to archived fellowship %',
                NEW.fellowship_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_application_archive_parents()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_application_archive_parents()
    TO service_role;

DROP TRIGGER IF EXISTS trg_application_archive_parents ON public.application;

CREATE TRIGGER trg_application_archive_parents
    BEFORE INSERT OR UPDATE OF student_id, fellowship_id ON public.application
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_application_archive_parents();

COMMENT ON FUNCTION public.guard_application_archive_parents() IS
    'Non-RPC invoker-security guard: application rows may only reference ACTIVE students/fellowships. INSERT of a child referencing an archived student/fellowship and UPDATE re-linking to an archived student/fellowship are rejected with 42501 for non-trusted sessions; historical reads and non-reference updates are unaffected.';

-- --- advising_meeting (student_id) ---
CREATE OR REPLACE FUNCTION public.guard_advising_meeting_archive_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create an advising meeting referencing archived student % (restore the student or choose an active student)',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.student_id IS DISTINCT FROM OLD.student_id
           AND NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link an advising meeting to archived student %',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advising_meeting_archive_student()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_advising_meeting_archive_student()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advising_meeting_archive_student ON public.advising_meeting;

CREATE TRIGGER trg_advising_meeting_archive_student
    BEFORE INSERT OR UPDATE OF student_id ON public.advising_meeting
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advising_meeting_archive_student();

COMMENT ON FUNCTION public.guard_advising_meeting_archive_student() IS
    'Non-RPC invoker-security guard: advising meetings may only reference ACTIVE students. INSERT referencing an archived student and UPDATE re-linking to an archived student are rejected with 42501 for non-trusted sessions; historical reads and non-reference updates are unaffected.';

-- --- fellowship_thursday (student_id) ---
CREATE OR REPLACE FUNCTION public.guard_fellowship_thursday_archive_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create fellowship-thursday attendance referencing archived student % (restore the student or choose an active student)',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.student_id IS DISTINCT FROM OLD.student_id
           AND NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link fellowship-thursday attendance to archived student %',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_fellowship_thursday_archive_student()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_fellowship_thursday_archive_student()
    TO service_role;

DROP TRIGGER IF EXISTS trg_fellowship_thursday_archive_student ON public.fellowship_thursday;

CREATE TRIGGER trg_fellowship_thursday_archive_student
    BEFORE INSERT OR UPDATE OF student_id ON public.fellowship_thursday
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_fellowship_thursday_archive_student();

COMMENT ON FUNCTION public.guard_fellowship_thursday_archive_student() IS
    'Non-RPC invoker-security guard: fellowship-thursday attendance may only reference ACTIVE students. INSERT referencing an archived student and UPDATE re-linking to an archived student are rejected with 42501 for non-trusted sessions; historical reads and non-reference updates are unaffected.';

-- --- scholarship_history (student_id, fellowship_id) ---
CREATE OR REPLACE FUNCTION public.guard_scholarship_history_archive_parents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create scholarship history referencing archived student % (restore the student or choose an active student)',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        IF NEW.fellowship_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.fellowship f
                WHERE f.fellowship_id = NEW.fellowship_id
                  AND f.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot create scholarship history referencing archived fellowship % (restore the fellowship or choose an active fellowship)',
                NEW.fellowship_id
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.student_id IS DISTINCT FROM OLD.student_id
           AND NEW.student_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.student s
                WHERE s.student_id = NEW.student_id
                  AND s.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link scholarship history to archived student %',
                NEW.student_id
                USING ERRCODE = '42501';
        END IF;

        IF NEW.fellowship_id IS DISTINCT FROM OLD.fellowship_id
           AND NEW.fellowship_id IS NOT NULL
           AND EXISTS (
               SELECT 1 FROM public.fellowship f
                WHERE f.fellowship_id = NEW.fellowship_id
                  AND f.archived_at IS NOT NULL
           )
        THEN
            RAISE EXCEPTION
                'cannot re-link scholarship history to archived fellowship %',
                NEW.fellowship_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_scholarship_history_archive_parents()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_scholarship_history_archive_parents()
    TO service_role;

DROP TRIGGER IF EXISTS trg_scholarship_history_archive_parents ON public.scholarship_history;

CREATE TRIGGER trg_scholarship_history_archive_parents
    BEFORE INSERT OR UPDATE OF student_id, fellowship_id ON public.scholarship_history
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_scholarship_history_archive_parents();

COMMENT ON FUNCTION public.guard_scholarship_history_archive_parents() IS
    'Non-RPC invoker-security guard: scholarship history rows may only reference ACTIVE students/fellowships. INSERT referencing an archived student/fellowship and UPDATE re-linking to an archived student/fellowship are rejected with 42501 for non-trusted sessions; historical reads and non-reference updates are unaffected.';