-- ============================================================================
-- OCF Fellowship Management System — Entity Lifecycle Archiving
--
-- Forward-only, additive migration (AI-DLC change
-- 2026-09-30-entity-lifecycle-archiving, approved design). Replaces the
-- normal destructive delete of students/fellowships/advisors with a secure,
-- reversible lifecycle model that preserves every historical relationship:
--
--   1. adds nullable `student.archived_at` and `fellowship.archived_at`
--      (timestamptz). NULL = ACTIVE; a database-authored timestamp =
--      ARCHIVED. This is the single lifecycle representation for each entity.
--      Existing rows are untouched and remain NULL (active) — no historical
--      lifecycle data is guessed or backfilled;
--   2. adds lifecycle indexes for active/archive filtering;
--   3. adds the trusted administrator predicate `public.is_ocf_admin()`,
--      which reads the IMMUTABLE Auth JWT `app_metadata.ocf_admin = true`
--      claim. The mutable `public.advisor.role` column is NEVER authorization;
--   4. adds the migration-owned SECURITY DEFINER RPC
--      `public.lifecycle_transition(entity, action, entity_id)` — the ONLY
--      normal lifecycle path. It derives the actor from `auth.uid()`, requires
--      `is_ocf_admin()`, whitelists exactly
--      student/fellowship archive|restore and advisor
--      deactivate|reactivate, stamps state in the database (`now()` for
--      archived_at, boolean for is_active), is idempotent (no-op when the
--      target is already in the requested state), and returns the resulting
--      state. `advisor.is_active` is retained as the sole advisor lifecycle
--      representation;
--   5. guards the lifecycle fields (`student.archived_at`,
--      `fellowship.archived_at`, `advisor.is_active`) from direct
--      authenticated table writes with invoker-security column-scoped
--      triggers. Only the lifecycle RPC (a SECURITY DEFINER function owned by
--      the migration owner) or a trusted `service_role`/DBA session may write
--      them; ordinary active-advisor updates to all other columns are
--      untouched. INSERT forgery of a lifecycle state is rejected too;
--   6. SELF-DEACTIVATION GUARD: the RPC refuses to deactivate the advisor row
--      bound to the caller's own `auth_user_id` while it is active. Deactivating
--      your own account immediately flips `is_active_advisor()` to false and
--      strands the acting administrator (their session is instantly denied by
--      `requireAdvisor`/RLS, and there is no self-reactivation path), so the
--      safer deliberate behavior is to require a SECOND administrator to
--      deactivate an administrator's account. Deactivating an already-inactive
--      row (idempotent no-op) and reactivating your own row remain allowed.
--
-- Every FK definition is untouched: all foreign keys keep the default
-- NO ACTION semantics, and no archive/deactivate action deletes, nulls, or
-- cascades historical relationships.
--
-- Forward-only, idempotent on re-apply: no existing migration, table, column,
-- row, FK, or RLS policy is edited, deleted, or reset.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Lifecycle columns: student.archived_at, fellowship.archived_at
--
-- NULL = active, a database-authored timestamptz = archived. Existing rows
-- keep NULL (active). No default expression: the RPC (or a trusted technical
-- session) is the only writer, so a DEFAULT would be misleading.
-- ---------------------------------------------------------------------------
ALTER TABLE public.student
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE public.fellowship
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

COMMENT ON COLUMN public.student.archived_at IS
    'Database-authored archive timestamp; NULL means the student is active. Written only by the lifecycle_transition RPC (or a trusted service_role/DBA session).';

COMMENT ON COLUMN public.fellowship.archived_at IS
    'Database-authored archive timestamp; NULL means the fellowship is active. Written only by the lifecycle_transition RPC (or a trusted service_role/DBA session).';

-- ---------------------------------------------------------------------------
-- 2. Lifecycle indexes (active-workflow filters and archive listings)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_student_archived_at
    ON public.student (archived_at);

CREATE INDEX IF NOT EXISTS idx_fellowship_archived_at
    ON public.fellowship (archived_at);

-- ---------------------------------------------------------------------------
-- 3. Trusted administrator predicate
--
-- Reads ONLY the immutable Auth JWT `app_metadata.ocf_admin = true` claim.
-- Users cannot edit app_metadata through standard client APIs, and the mutable
-- `public.advisor.role` column is never consulted. SECURITY INVOKER: the JWT
-- claim GUCs (`request.jwt.claims`) are request-scoped and resolve identically
-- for authenticated and definer contexts, so no definer privilege is needed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_ocf_admin()
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'ocf_admin', '') = 'true';
$$;

REVOKE ALL ON FUNCTION public.is_ocf_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_ocf_admin() TO authenticated;

COMMENT ON FUNCTION public.is_ocf_admin() IS
    'Trusted administrator predicate: true only when the immutable Auth JWT app_metadata claim ocf_admin equals true. The mutable public.advisor.role column is never authorization.';

-- ---------------------------------------------------------------------------
-- 4. Lifecycle RPC: public.lifecycle_transition(entity, action, entity_id)
--
-- SECURITY DEFINER (migration-owned, empty search_path, fully qualified
-- relations): the ONLY normal path that writes lifecycle state. The actor is
-- derived exclusively from auth.uid() — never accepted as a parameter — and a
-- technical (service_role/DBA) session without a JWT subject is rejected, so
-- every transition is attributable to a specific authenticated administrator.
-- Authorization is `is_ocf_admin()` only.
--
-- Whitelist (anything else fails closed):
--   student   archive | restore   -> sets/clears student.archived_at := now()
--   fellowship archive | restore   -> sets/clears fellowship.archived_at := now()
--   advisor   deactivate | reactivate -> sets advisor.is_active false/true
--
-- Idempotent: a transition that would leave the row in its current state is a
-- no-op (`applied = false`) returning the unchanged current state. Each target
-- row is locked FOR UPDATE so a concurrent transition cannot race the
-- read-compute-write. Returns the resulting state for the caller.
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

    -- Authorization: the immutable Auth app_metadata claim ocf_admin=true.
    -- The mutable public.advisor.role column is NEVER consulted.
    IF NOT public.is_ocf_admin() THEN
        RAISE EXCEPTION 'only an administrator (Auth app_metadata ocf_admin=true) may perform lifecycle transitions'
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
        -- acting administrator (session denied by requireAdvisor/RLS, no
        -- self-reactivation path), so a second administrator must perform the
        -- deactivation. Idempotent no-ops (already inactive) and reactivation
        -- of the caller's own row remain allowed.
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

REVOKE ALL ON FUNCTION public.lifecycle_transition(text, text, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lifecycle_transition(text, text, integer)
    TO authenticated;

COMMENT ON FUNCTION public.lifecycle_transition(text, text, integer) IS
    'Admin-only (Auth app_metadata ocf_admin=true) idempotent lifecycle RPC. Whitelisted transitions: student/fellowship archive|restore (sets/clears archived_at := now()) and advisor deactivate|reactivate (sets is_active). Actor derived from auth.uid(); state stamped in the database; returns the resulting state. Self-deactivation of the caller''s own active advisor row is rejected.';

-- ---------------------------------------------------------------------------
-- 5. Direct-write guards on lifecycle fields
--
-- Column-scoped invoker-security triggers. RLS remains the first gate, but
-- RLS alone would still let an active advisor write lifecycle columns on
-- student/fellowship (FOR ALL policies) or deactivate a peer via
-- `advisor_update_active_staff_only`. These triggers close that path fail-
-- closed for every non-trusted session:
--
--   - SECURITY INVOKER (never DEFINER): current_user/session_user reflect the
--     real executing session, so the trust check cannot be granted away by
--     definer privilege;
--   - trusted writers are the lifecycle RPC (SECURITY DEFINER owned by the
--     migration owner -> current_user = 'postgres'), a service_role/legacy
--     service-role-JWT session, and a DBA psql session (session_user =
--     'postgres'). Everything else is rejected with 42501;
--   - a no-op write (NEW value identical to OLD / INSERT with the active
--     default) passes through, so ordinary advisor/student/fellowship
--     maintenance updates that happen to restate the current lifecycle value
--     are never blocked;
--   - INSERT forgery of a lifecycle state (a row created already-archived or
--     already-inactive by an authenticated session) is rejected too.
--
-- Trigger functions get EXECUTE revoked from PUBLIC/anon/authenticated and
-- pinned to service_role so the ACL stays non-empty (a default ACL would grant
-- EXECUTE to PUBLIC). The trigger mechanism invokes them without any EXECUTE
-- grant; direct RPC invocation is harmless (they require NEW/OLD).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_student_archived_at_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- INSERT: an active row (archived_at NULL) is the ordinary active-advisor
    -- creation path. Creating an already-archived row is a forged lifecycle
    -- state and is trusted-session-only.
    IF TG_OP = 'INSERT' THEN
        IF NEW.archived_at IS NULL THEN
            RETURN NEW;
        END IF;

        IF current_user = 'service_role'
           OR auth.role() = 'service_role'
           OR session_user = 'postgres'
           OR current_user = 'postgres'
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'student.archived_at is a database-managed lifecycle field and cannot be set when creating a student through the client API'
            USING ERRCODE = '42501';
    END IF;

    -- UPDATE no-op: the value did not change. Pass through so ordinary updates
    -- that restate the current lifecycle value are never blocked.
    IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
        RETURN NEW;
    END IF;

    -- Trusted technical sessions: the SECURITY DEFINER lifecycle RPC (owned by
    -- the migration owner) and service_role/DBA writes.
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'student.archived_at is a database-managed lifecycle field: it may be set or cleared only by the lifecycle_transition RPC (admin app_metadata ocf_admin=true) or a trusted service_role/DBA session'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_student_archived_at_lifecycle()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_student_archived_at_lifecycle()
    TO service_role;

DROP TRIGGER IF EXISTS trg_student_archived_at_lifecycle ON public.student;

CREATE TRIGGER trg_student_archived_at_lifecycle
    BEFORE INSERT OR UPDATE OF archived_at ON public.student
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_student_archived_at_lifecycle();

COMMENT ON FUNCTION public.guard_student_archived_at_lifecycle() IS
    'Non-RPC invoker-security guard: student.archived_at may only be written by the lifecycle_transition RPC or a trusted service_role/DBA session; direct authenticated INSERT/UPDATE writes of the lifecycle field are rejected. Ordinary updates to other columns never fire it (column-scoped trigger).';

CREATE OR REPLACE FUNCTION public.guard_fellowship_archived_at_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.archived_at IS NULL THEN
            RETURN NEW;
        END IF;

        IF current_user = 'service_role'
           OR auth.role() = 'service_role'
           OR session_user = 'postgres'
           OR current_user = 'postgres'
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'fellowship.archived_at is a database-managed lifecycle field and cannot be set when creating a fellowship through the client API'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
        RETURN NEW;
    END IF;

    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'fellowship.archived_at is a database-managed lifecycle field: it may be set or cleared only by the lifecycle_transition RPC (admin app_metadata ocf_admin=true) or a trusted service_role/DBA session'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_fellowship_archived_at_lifecycle()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_fellowship_archived_at_lifecycle()
    TO service_role;

DROP TRIGGER IF EXISTS trg_fellowship_archived_at_lifecycle ON public.fellowship;

CREATE TRIGGER trg_fellowship_archived_at_lifecycle
    BEFORE INSERT OR UPDATE OF archived_at ON public.fellowship
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_fellowship_archived_at_lifecycle();

COMMENT ON FUNCTION public.guard_fellowship_archived_at_lifecycle() IS
    'Non-RPC invoker-security guard: fellowship.archived_at may only be written by the lifecycle_transition RPC or a trusted service_role/DBA session; direct authenticated INSERT/UPDATE writes of the lifecycle field are rejected. Ordinary updates to other columns never fire it (column-scoped trigger).';

CREATE OR REPLACE FUNCTION public.guard_advisor_is_active_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- INSERT: an active advisor row (is_active = true, the column default) is
    -- the ordinary active-staff creation path. Creating an already-inactive
    -- advisor is a forged lifecycle state and is trusted-session-only.
    IF TG_OP = 'INSERT' THEN
        IF NEW.is_active THEN
            RETURN NEW;
        END IF;

        IF current_user = 'service_role'
           OR auth.role() = 'service_role'
           OR session_user = 'postgres'
           OR current_user = 'postgres'
        THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'advisor.is_active is a database-managed lifecycle field and cannot be set to inactive when creating an advisor through the client API'
            USING ERRCODE = '42501';
    END IF;

    -- UPDATE no-op: the value did not change. Pass through so ordinary updates
    -- that restate the current lifecycle value are never blocked.
    IF NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
        RETURN NEW;
    END IF;

    -- Trusted technical sessions: the SECURITY DEFINER lifecycle RPC (owned by
    -- the migration owner) and service_role/DBA writes. This is what makes
    -- advisor deactivate/reactivate RPC-only; an active advisor can no longer
    -- deactivate peers (or themselves) through the broad UPDATE policy.
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'advisor.is_active is a database-managed lifecycle field: it may be changed only by the lifecycle_transition RPC (admin app_metadata ocf_admin=true) or a trusted service_role/DBA session'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advisor_is_active_lifecycle()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_advisor_is_active_lifecycle()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advisor_is_active_lifecycle ON public.advisor;

CREATE TRIGGER trg_advisor_is_active_lifecycle
    BEFORE INSERT OR UPDATE OF is_active ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advisor_is_active_lifecycle();

COMMENT ON FUNCTION public.guard_advisor_is_active_lifecycle() IS
    'Non-RPC invoker-security guard: advisor.is_active may only be written by the lifecycle_transition RPC or a trusted service_role/DBA session; direct authenticated INSERT/UPDATE writes of the lifecycle field (including peer deactivation through the broad active-staff UPDATE policy) are rejected. Ordinary updates to other advisor columns never fire it (column-scoped trigger).';