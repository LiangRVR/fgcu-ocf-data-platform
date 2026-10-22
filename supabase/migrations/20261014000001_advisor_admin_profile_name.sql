-- ============================================================================
-- OCF Fellowship Management System — Effective-Admin profile-name update RPC
--
-- Forward-only, additive migration for the approved
-- `advisor-admin-immutable-history` design (AI-DLC). It closes the review
-- gap recorded in that change's review.md: previously, the only supported
-- path for an effective Admin to change another advisor's permitted profile
-- data was a private SQL session (technical trusted-actor context), not a
-- production server operation. This migration adds exactly that production
-- path as an authenticated-only, hardened SECURITY DEFINER RPC.
--
-- What this migration adds (nothing is removed or replaced)
-- -------------------------------------------------------------------------
--   `public.update_advisor_profile_name(p_advisor_id, p_advisor_name)` —
--   an authenticated-only SECURITY DEFINER RPC with `SET search_path = ''`
--   and fully qualified references. It:
--
--   1. Derives the actor ONLY from `auth.uid()` (the JWT subject). There is
--      no actor parameter; a technical/service session has no `auth.uid()`
--      and is rejected fail-closed.
--   2. Validates the actor with the EXISTING effective-Admin boundary
--      (`public.is_effective_admin()`: immutable Auth app_metadata
--      `ocf_admin = true` AND a current ACTIVE pre-bound advisor row). The
--      mutable `advisor.role` display column and a possibly-stale JWT are
--      never authorization.
--   3. Rejects updating the caller's own row: ordinary self-service name
--      updates stay on the existing self-service profile path, so this
--      Admin path never becomes a second self-write route and the profile
--      PATCH keeps emitting the self-attributed event.
--   4. Validates the target (must exist) and the name (non-blank, trimmed,
--      at most 120 characters, and not colliding with another advisor's
--      unique name).
--   5. Writes ONLY `advisor.advisor_name`. `email` is unreachable: the RPC
--      signature has no email parameter, and the existing column-scoped
--      invoker-security email guard (`trg_advisor_email_direct_write`,
--      migration 20261013000001) still rejects every non-trusted email
--      change — no Auth-identity divergence path is created or weakened.
--   6. Lets the existing advisor audit trigger
--      (`trg_audit_advisor_current_state` /
--      `private.audit_advisor_change`, migration 20261013000001) write
--      exactly ONE `advisor/updated` event inside the same transaction.
--      Because the RPC runs in the authenticated session, the helper's
--      `auth.uid()` actor resolution attributes the event to the acting
--      Admin (origin `user`, frozen actor-name snapshot). A no-op
--      restatement diffs to an empty changes set in the trigger and records
--      NO event — the existing no-op suppression is preserved unchanged.
--   7. Does not touch `role`, `is_active`, `auth_user_id`, or `email`;
--      role/lifecycle/binding controls and their guards, all RLS policies,
--      all grants, and immutable audit stay intact. No reason is required or
--      supplied (R8: ordinary profile edits do not require a reason), so no
--      `ocf.audit_reason` context is set and lifecycle/role reason semantics
--      are unaffected.
--
-- Preserved unchanged: Supabase Auth, one-time binding, the effective-Admin
-- model, the service-role-only atomic role boundary, the lifecycle
-- authorization boundary, direct-write guards, grants/RLS, the immutable
-- `audit_event` surface, `advisor_role_lock` infrastructure, and all
-- unrelated working-tree changes.
--
-- Security boundary: SECURITY DEFINER with empty `search_path` and fully
-- schema-qualified references. EXECUTE is revoked from PUBLIC/anon and
-- service_role and granted to `authenticated` only — the same ACL posture as
-- `lifecycle_transition`. The audit event is still written by the existing
-- private SECURITY DEFINER helper; no client can write or mutate history.
-- No down migration is provided.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- `public.update_advisor_profile_name`
--
-- Authenticated-only trusted RPC: an effective Admin updates ANOTHER
-- advisor's permitted profile display name. The actor is derived from
-- `auth.uid()` and validated with the existing effective-Admin boundary;
-- the target and name are validated; only `advisor_name` is written so the
-- existing advisor audit trigger emits exactly one attributed `updated`
-- event (or none for a no-op).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_advisor_profile_name(
    p_advisor_id integer,
    p_advisor_name text
)
RETURNS TABLE (
    advisor_id integer,
    advisor_name character varying
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid;
    v_actor_advisor_id integer;
    v_new_name varchar;
BEGIN
    -- Fail closed on missing/invalid input BEFORE any authorization work.
    IF p_advisor_id IS NULL THEN
        RAISE EXCEPTION 'update_advisor_profile_name requires an advisor id'
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

    -- The acting Admin is the authenticated JWT subject ONLY. A technical
    -- (service_roles/DBA) session has no auth.uid() and is rejected: a peer
    -- profile update must always be attributable to a specific
    -- authenticated administrator.
    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'updating another advisor''s name requires an authenticated administrator session'
            USING ERRCODE = '42501';
    END IF;

    -- Existing effective-Admin boundary (never a parameter, never the
    -- mutable display role): trusted boolean Auth app_metadata claim AND a
    -- current ACTIVE pre-bound advisor row.
    IF NOT public.is_effective_admin() THEN
        RAISE EXCEPTION 'only an effective administrator may update another advisor''s name (Auth app_metadata ocf_admin=true and an active bound advisor row are required)'
            USING ERRCODE = '42501';
    END IF;

    -- Resolve the actor's advisor id for the self-target rejection below.
    SELECT a.advisor_id
      INTO v_actor_advisor_id
      FROM public.advisor AS a
     WHERE a.auth_user_id = v_actor
       AND a.is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'the authenticated session has no unique active bound advisor row; peer name update refused'
            USING ERRCODE = '42501';
    END IF;

    -- ANOTHER advisor only. Self-service name edits remain the sole owner of
    -- the caller's own row via the ordinary profile path (self-attributed);
    -- this Admin path must not become a second self-write route.
    IF p_advisor_id = v_actor_advisor_id THEN
        RAISE EXCEPTION 'use the self-service profile update to change your own name; this route updates another advisor'
            USING ERRCODE = '22023';
    END IF;

    -- Lock the target row so concurrent name/role/lifecycle writes serialize,
    -- and confirm it exists.
    PERFORM 1
      FROM public.advisor AS a
     WHERE a.advisor_id = p_advisor_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'advisor % does not exist', p_advisor_id
            USING ERRCODE = 'P0002';
    END IF;

    -- Friendly duplicate-name check; the UNIQUE(advisor_name) constraint is
    -- the authoritative backstop (a race raises unique_violation and rolls
    -- back state + audit together, preserving transaction atomicity).
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

    -- Write ONLY the permitted display name. The existing advisor audit
    -- trigger fires once: an effective change produces exactly one
    -- `advisor/updated` event attributed to the acting Admin (auth.uid());
    -- a no-op restatement diff is empty and records nothing.
    UPDATE public.advisor AS a
       SET advisor_name = btrim(p_advisor_name)
     WHERE a.advisor_id = p_advisor_id
     RETURNING a.advisor_name INTO v_new_name;

    RETURN QUERY
    SELECT p_advisor_id, v_new_name;
END;
$$;

REVOKE ALL ON FUNCTION public.update_advisor_profile_name(integer, text)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_advisor_profile_name(integer, text)
    TO authenticated;

COMMENT ON FUNCTION public.update_advisor_profile_name(integer, text) IS
    'Authenticated-only trusted RPC: an effective Admin (actor derived from auth.uid() and validated with public.is_effective_admin() — never a parameter) updates ANOTHER advisor''s permitted profile display name. Only advisor_name is writable (no email parameter/list path), the target row must exist, the name must be non-blank and <=120 chars and must not collide with another advisor''s unique name, and the caller''s own row is refused (self-service updates stay on the profile API). The write is a single UPDATE of advisor_name, so the existing advisor audit trigger emits exactly one advisor/updated event attributed to the acting Admin in the same transaction; a no-op restatement records nothing via the existing no-op suppression. Role/lifecycle/binding/email controls, RLS, grants, and immutable audit are untouched and no reason is required. EXECUTE pinned to authenticated only.';

-- ============================================================================
-- End of migration. Additive function + ACL only; no existing business row is
-- edited, deleted, or reset, and no prior migration, policy, grant, trigger,
-- or audit row is weakened. Forward-only.
-- ============================================================================