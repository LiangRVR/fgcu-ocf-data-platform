-- ============================================================================
-- OCF Fellowship Management System — Explicit Admin/Advisor Permissions
--
-- Forward-only, additive migration (AI-DLC change
-- 2026-10-01-explicit-admin-advisor-permissions, approved design). Implements
-- the two-role handoff model at the database boundary:
--
--   1. normalizes `advisor.role` to exactly the display values `Admin` /
--      `Advisor` (existing lowercase values are mapped by the forward-only
--      migration before the constraint is enforced) and adds a CHECK
--      constraint pinning the vocabulary. The column default becomes
--      `'Advisor'`. `advisor.role` is PRESENTATION/audit state only — it is
--      NEVER an RLS/RPC authorization input (authorization stays on the
--      immutable Auth `app_metadata.ocf_admin` claim);
--   2. hardens `public.is_ocf_admin()` to compare a JSON boolean (not text
--      coercion): only the Auth-issued boolean `app_metadata.ocf_admin = true`
--      claim satisfies it, so a string `"true"` claim is never accepted;
--   3. adds `public.is_effective_admin()`, the database effective-Admin
--      predicate: an active, PRE-BOUND advisor (`advisor.auth_user_id =
--      auth.uid()` AND `is_active = true`) carrying the boolean admin claim.
--      The mutable display role is never consulted;
--   4. adds an invoker-security column-scoped guard
--      (`trg_advisor_role_display` / `guard_advisor_role_display`) that denies
--      direct authenticated writes to `advisor.role` — active-staff creation
--      of an `Admin` row and any authenticated role change (self or peer) are
--      rejected fail-closed with 42501. Only trusted `service_role` / DBA
--      sessions (the server-only provisioning adapter) may set the display
--      role. Ordinary staff edits to other advisor columns, no-op
--      restatements, and the safe `'Advisor'` default creation path are
--      unaffected.
--
-- Preserved unchanged: the one-time `auth_user_id` bind guard, the
-- `is_active` lifecycle guard, the existing active-advisor RLS model, the
-- append-only advising meeting/amendment invariants, the lifecycle RPC
-- (`lifecycle_transition`), and every FK (all `NO ACTION`). No existing
-- migration, table, column, row, FK, or RLS policy is edited, deleted, or
-- reset. Idempotent on re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Normalize advisor.role to the exact display vocabulary, then constrain.
--
-- `advisor.role` is a protected visible projection (never authorization). The
-- forward-only normalization maps case-insensitive `admin` → `Admin`, and
-- every other value (including legacy free-form values) → the safe `Advisor`
-- default BEFORE the CHECK constraint is added, so the constraint never fails
-- on pre-existing rows. No row is deleted and no history is touched.
-- ---------------------------------------------------------------------------
UPDATE public.advisor
   SET role = 'Admin'
 WHERE role IS NOT NULL
   AND lower(role) = 'admin'
   AND role <> 'Admin';

UPDATE public.advisor
   SET role = 'Advisor'
 WHERE role IS NULL
    OR (role <> 'Admin' AND lower(role) <> 'admin');

ALTER TABLE public.advisor
    ALTER COLUMN role SET DEFAULT 'Advisor';

ALTER TABLE public.advisor
    DROP CONSTRAINT IF EXISTS advisor_role_display_check;

ALTER TABLE public.advisor
    ADD CONSTRAINT advisor_role_display_check
    CHECK (role IN ('Admin', 'Advisor'));

COMMENT ON COLUMN public.advisor.role IS
    'Protected display role (exactly Admin or Advisor). Presentation/audit state only — NEVER an RLS/RPC authorization input. Written only by trusted server-side provisioning (service_role/DBA) or the default at advisor creation.';

-- ---------------------------------------------------------------------------
-- 2. is_ocf_admin(): strict JSON-boolean claim comparison.
--
-- Previously the predicate compared the extracted TEXT of the claim with the
-- string 'true', which would also accept a non-boolean string claim. The
-- effective Admin authority must be the trusted server-issued JSON BOOLEAN
-- `app_metadata.ocf_admin = true`; a string claim is never accepted. Same
-- SECURITY INVOKER posture and empty search_path as the original (the JWT
-- claim GUCs resolve identically for authenticated and definer contexts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_ocf_admin()
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT coalesce(
        auth.jwt() -> 'app_metadata' -> 'ocf_admin',
        'false'::jsonb
    ) = 'true'::jsonb;
$$;

REVOKE ALL ON FUNCTION public.is_ocf_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_ocf_admin() TO authenticated;

COMMENT ON FUNCTION public.is_ocf_admin() IS
    'Trusted administrator claim predicate: true only when the immutable Auth JWT app_metadata claim ocf_admin is the JSON boolean true (a string "true" is never accepted). The mutable public.advisor.role column is never authorization.';

-- ---------------------------------------------------------------------------
-- 3. is_effective_admin(): the database effective-Admin predicate.
--
-- Effective Admin authority requires BOTH the trusted boolean JWT claim AND a
-- current, ACTIVE, pre-bound advisor identity (`advisor.auth_user_id =
-- auth.uid()` AND `is_active = true`). SECURITY DEFINER so the advisor lookup
-- bypasses RLS and reflects the true row state (mirrors is_active_advisor);
-- the JWT claim check inside is unaffected by definer context. The mutable
-- display role is never consulted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_effective_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.is_ocf_admin()
       AND EXISTS (
           SELECT 1 FROM public.advisor a
            WHERE a.auth_user_id = auth.uid()
              AND a.is_active = true
       );
$$;

REVOKE ALL ON FUNCTION public.is_effective_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_effective_admin() TO authenticated;

COMMENT ON FUNCTION public.is_effective_admin() IS
    'Effective Admin predicate: true only when the session carries the trusted boolean Auth app_metadata ocf_admin=true claim AND is bound to a current ACTIVE advisor row (advisor.auth_user_id = auth.uid() AND is_active = true). The mutable public.advisor.role display column is never authorization.';

-- ---------------------------------------------------------------------------
-- 4. Direct-write guard on advisor.role (protected display projection).
--
-- Column-scoped invoker-security trigger, same trust model as the existing
-- lifecycle / one-time-bind guards:
--
--   - INSERT: creating an advisor row with the safe default/display role
--     'Advisor' is the ordinary active-staff creation path and passes. Creating
--     a row already carrying 'Admin' is a provisioning action and is
--     trusted-session-only (42501 otherwise).
--   - UPDATE: a no-op restatement (value unchanged) passes through; any actual
--     change — self or peer role change through the broad active-staff UPDATE
--     policy — is rejected fail-closed with 42501 for every non-trusted
--     session.
--   - Trusted writers are the server-only provisioning adapter (service_role),
--     a legacy service-role JWT session, and a DBA psql session
--     (session_user/current_user = 'postgres').
--
-- The CHECK constraint (step 1) enforces the vocabulary on every write;
-- RLS remains the first authorization gate; this guard closes the
-- role-escalation path that the broad active-staff UPDATE policy would
-- otherwise permit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_advisor_role_display()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    -- Trusted technical sessions: the server-only provisioning adapter
    -- (service_role) and DBA postgres may set the protected display role.
    IF current_user = 'service_role'
       OR auth.role() = 'service_role'
       OR session_user = 'postgres'
       OR current_user = 'postgres'
    THEN
        RETURN NEW;
    END IF;

    -- INSERT: the ordinary active-staff advisor-creation path creates the row
    -- with the safe 'Advisor' display role (the column default). Creating a row
    -- already displaying 'Admin' is a provisioning action and is trusted-only.
    IF TG_OP = 'INSERT' THEN
        IF NEW.role = 'Admin' THEN
            RAISE EXCEPTION
                'advisor.role is a protected display field: creating an Admin advisor requires trusted server-side provisioning'
                USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE no-op: the value did not change. Pass through so ordinary updates
    -- that restate the current display role are never blocked.
    IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'advisor.role is a protected display field: it may be changed only by trusted server-side provisioning (an effective Admin role update)'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_advisor_role_display()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_advisor_role_display()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advisor_role_display ON public.advisor;

CREATE TRIGGER trg_advisor_role_display
    BEFORE INSERT OR UPDATE OF role ON public.advisor
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_advisor_role_display();

COMMENT ON FUNCTION public.guard_advisor_role_display() IS
    'Non-RPC invoker-security guard: advisor.role (display projection) may be written only by trusted server-side provisioning (service_role/DBA). Authenticated self/peer role changes and the authenticated creation of an Admin row are rejected with 42501; the safe Advisor default creation path and no-op restatements pass through.';