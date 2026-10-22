-- ============================================================================
-- OCF Fellowship Management System — Per-Advisor Role-Change Serialization
--
-- Forward-only, additive migration. Independent review remediation for AI-DLC
-- change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Blocker — concurrent trusted role changes can produce inconsistent Auth
--   claim / display role. Two `setAdvisorRole` operations for the SAME advisor
--   running on different server instances can interleave their GoTrue
--   `app_metadata.ocf_admin` update and the protected `advisor.role` write
--   (e.g. one reads the prior claim, the other reads it, then each writes
--   claim + display independently), leaving claim and display role divergent.
--
--   Remediation — durable, CROSS-INSTANCE per-advisor serialization backed by
--   the database (no in-process mutex): a per-advisor lock/lease row that the
--   trusted provisioning adapter holds across the ENTIRE Auth-metadata +
--   protected-display-role operation.
--
--     - `advisor_role_lock` is a server-only table (RLS enabled, no policies;
--       privileges revoked from anon/authenticated, granted to service_role;
--       postgres/DBA owns it). Advisor rows are keyed by `advisor_id` (FK stays
--       the default NO ACTION, preserving the every-FK-NO-ACTION invariant).
--     - `acquire_advisor_role_lock(advisor_id, holder, lease_seconds)` is a
--       single atomic statement (INSERT ... ON CONFLICT DO UPDATE ... WHERE):
--       it grants the lease when no active lease exists OR the existing lease
--       has EXPIRED (bounded stale-lock recovery via the lease timestamp) OR
--       the SAME holder re-acquires (idempotent refresh). A concurrently-held
--       active lease returns false — the contending operation FAILS SAFELY
--       WITHOUT MUTATION (the adapter returns `lock_busy`).
--     - `release_advisor_role_lock(advisor_id, holder)` deletes the lock row
--       ONLY when the holder matches (safe release); it returns whether a row
--       was released. The adapter always releases in a `finally`, so the lock
--       is released reliably on success AND failure; a crashed holder is
--       recovered after the bounded lease expires.
--
-- No existing migration, table, column, row, FK, RLS policy, or function is
-- edited, deleted, or reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Server-only per-advisor lock table.
--
--    advisor_id       the advisor being role-changed (PK + FK, default
--                     NO ACTION so the every-FK-NO-ACTION invariant holds);
--    lease_expires_at when the lease expires; an EXPIRED lease can be taken
--                     over by any holder (bounded stale recovery);
--    holder           the operation's unique holder token (a UUID) — only the
--                     holder may release;
--    created_at       audit timestamp.
--
--    RLS is enabled with NO policies, so every non-superuser session is
--    denied; table privileges are revoked from anon/authenticated and granted
--    to service_role (which bypasses RLS) for the trusted adapter.
-- ---------------------------------------------------------------------------
CREATE TABLE public.advisor_role_lock (
    advisor_id integer NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    holder text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT advisor_role_lock_pkey PRIMARY KEY (advisor_id),
    CONSTRAINT advisor_role_lock_advisor_id_fkey
        FOREIGN KEY (advisor_id) REFERENCES public.advisor (advisor_id)
);

ALTER TABLE public.advisor_role_lock ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.advisor_role_lock FROM anon, authenticated;
GRANT ALL ON TABLE public.advisor_role_lock TO service_role;

COMMENT ON TABLE public.advisor_role_lock IS
    'Server-only per-advisor role-change lock/lease. RLS enabled with no policies (anon/authenticated fully denied; service_role/DBA only). Serializes the full Auth app_metadata + protected display-role operation across server instances; expired leases bound stale-lock recovery.';

-- ---------------------------------------------------------------------------
-- 2. Acquire (atomic lease grant / expired takeover / same-holder refresh).
--
--    A single statement:
--      * no row            → INSERT succeeds → lock acquired (true);
--      * row, lease expired→ UPDATE (takeover) → lock acquired (true);
--      * row, same holder  → UPDATE (idempotent refresh) → lock acquired (true);
--      * row, ACTIVE lease, DIFFERENT holder → UPDATE skipped (WHERE false) →
--        no row returned → lock NOT acquired (false) — the contending
--        operation must fail without mutation.
--
--    SECURITY DEFINER (postgres-owned, empty search_path, fully qualified
--    relations) so the service-role adapter can call it and RLS never gates it;
--    EXECUTE is pinned to service_role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acquire_advisor_role_lock(
    p_advisor_id integer,
    p_holder text,
    p_lease_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_acquired integer;
BEGIN
    -- Fail closed on a malformed lease request (holder is a required token;
    -- the lease must be a positive bounded duration).
    IF p_holder IS NULL OR p_holder = '' THEN
        RAISE EXCEPTION 'acquire_advisor_role_lock requires a non-empty holder'
            USING ERRCODE = '22023';
    END IF;
    IF p_lease_seconds IS NULL OR p_lease_seconds <= 0 OR p_lease_seconds > 86400 THEN
        RAISE EXCEPTION 'acquire_advisor_role_lock lease_seconds must be between 1 and 86400'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.advisor_role_lock (advisor_id, lease_expires_at, holder)
    VALUES (
        p_advisor_id,
        now() + make_interval(secs => p_lease_seconds),
        p_holder
    )
    ON CONFLICT (advisor_id) DO UPDATE
        SET lease_expires_at = excluded.lease_expires_at,
            holder = excluded.holder
        WHERE public.advisor_role_lock.lease_expires_at <= now()
           OR public.advisor_role_lock.holder = p_holder
    RETURNING advisor_id INTO v_acquired;

    RETURN v_acquired IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_advisor_role_lock(integer, text, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_advisor_role_lock(integer, text, integer)
    TO service_role;

COMMENT ON FUNCTION public.acquire_advisor_role_lock(integer, text, integer) IS
    'Atomic per-advisor lease acquire: true when this holder now owns the lease (fresh insert, expired-lead takeover, or same-holder refresh); false when a DIFFERENT holder owns an ACTIVE lease (the contender must fail without mutation). Bounded stale recovery via lease_expires_at.';

-- ---------------------------------------------------------------------------
-- 3. Release (holder-scoped delete).
--
--    Deletes the lock row ONLY for the matching holder and returns whether a
--    row was released. A non-holder cannot release another operation's lease
--    (safe release); a stale lease that was never released is recovered by the
--    acquire takeover after expiry.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_advisor_role_lock(
    p_advisor_id integer,
    p_holder text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted integer;
BEGIN
    DELETE FROM public.advisor_role_lock
     WHERE advisor_id = p_advisor_id
       AND holder = p_holder;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.release_advisor_role_lock(integer, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_advisor_role_lock(integer, text)
    TO service_role;

COMMENT ON FUNCTION public.release_advisor_role_lock(integer, text) IS
    'Holder-scoped lease release: deletes the advisor_role_lock row only when holder matches and returns true if a row was released; false otherwise. Non-holders cannot release another operation''s lease.';

-- ---------------------------------------------------------------------------
-- 4. Bounded stale-lock hygiene: an expired lock row that is never released is
--    taken over by the next acquire (see step 2); no periodic cleanup is
--    required, but the PK gives an O(1) takeover path.
-- ---------------------------------------------------------------------------