-- ============================================================================
-- OCF Fellowship Management System — Advisor Self-Service + Role Reconciliation
--
-- Forward-only, additive migration. Independent review remediation for AI-DLC
-- change 2026-10-01-explicit-admin-advisor-permissions:
--
--   Blocker 1 — remove broad authenticated advisor INSERT/peer UPDATE access:
--   an active authenticated advisor may update ONLY their own bound row's
--   allowed profile fields, and direct authenticated advisor-row creation is
--   denied. Trusted `service_role`/DBA sessions (the server-only provisioning
--   adapter and E2E seeding) bypass RLS and keep every protected management
--   flow functional; the column-scoped role/lifecycle/one-time-bind guards
--   still protect `role`, `is_active`, and `auth_user_id` on the self row.
--
--     - DROP `advisor_insert_active_staff`: authenticated advisors can no
--       longer create advisor rows through the table API. RLS now denies the
--       INSERT (42501) before any trigger.
--     - REPLACE `advisor_update_active_staff_only` (broad peer UPDATE) with a
--       SELF-SCOPED `advisor_update_own_profile` policy: `auth_user_id =
--       auth.uid()` AND `is_active_advisor()`. An ACTIVE, pre-bound advisor may
--       update their own row; peer rows are invisible (0 rows / RLS denial),
--       and inactive/unbound sessions have no UPDATE path. `role`,
--       `is_active`, and `auth_user_id` remain guarded by the existing
--       invoker-security column-scoped triggers, so the self-scoped path is
--       limited to allowed own-profile fields (e.g. `advisor_name`, `email`).
--
--   Blocker 2 — persistently align the display role with the Auth claim:
--   reconcile every existing advisor row's `role` so that a bound advisor is
--   `Admin` ONLY when their Auth `auth.users.raw_app_meta_data` carries the
--   JSON boolean `ocf_admin = true`, and `Advisor` otherwise (unbound rows,
--   orphaned bindings, non-boolean/string claims, and missing metadata all
--   resolve to the safe `Advisor` default — the same strict boolean rule as
--   `public.is_ocf_admin()`). This makes the protected display projection
--   follow the trusted Auth authority, not a free-form text value.
--
-- Preserved unchanged: the one-time `auth_user_id` bind guard, the `is_active`
-- lifecycle guard, the role-display guard, the active-advisor SELECT model,
-- the append-only advising meeting/amendment invariants, the lifecycle RPC,
-- and every FK (all `NO ACTION`). No existing migration, table, column, row
-- (other than the reconciling `role` display values), or RLS policy outside
-- the two advisor policies is edited, deleted, or reset. Idempotent on
-- re-apply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Blocker 1 — self-scoped advisor write boundary.
--
--   1a. Deny authenticated advisor-row creation entirely.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_insert_active_staff"
    ON public.advisor;

-- ---------------------------------------------------------------------------
--   1b. Self-scoped advisor UPDATE: an ACTIVE, pre-bound advisor may update
--       only their own bound row. The column-scoped role/lifecycle/one-time-
--       bind triggers still reject writes to `role`, `is_active`, and
--       `auth_user_id`, so the RLS self-scope only opens allowed own-profile
--       fields. Peer rows are not visible for UPDATE (0 rows / RLS denial),
--       and inactive/unbound sessions have no UPDATE path at all.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "advisor_update_active_staff_only"
    ON public.advisor;

CREATE POLICY "advisor_update_own_profile"
    ON public.advisor
    FOR UPDATE TO authenticated
    USING (
        auth_user_id = auth.uid()
        AND public.is_active_advisor()
    )
    WITH CHECK (
        auth_user_id = auth.uid()
        AND public.is_active_advisor()
    );

COMMENT ON POLICY "advisor_update_own_profile" ON public.advisor IS
    'Self-scoped advisor update: an active, pre-bound advisor may update only their own bound row (auth_user_id = auth.uid() AND is_active_advisor()). Peer rows are invisible for UPDATE and authenticated advisor-row INSERT is denied (advisor_insert_active_staff dropped). role/is_active/auth_user_id stay protected by column-scoped invoker-security triggers; trusted service_role/DBA sessions bypass RLS.';

-- ---------------------------------------------------------------------------
-- 2. Blocker 2 — reconcile the display role with the Auth claim.
--
--    For every advisor row, the protected display `role` follows the trusted
--    Auth authority:
--
--      Admin   ⇔ bound to an auth user whose `raw_app_meta_data` has the
--                JSON BOOLEAN `ocf_admin = true` (strict; a string "true" is
--                never accepted — identical to `public.is_ocf_admin()`);
--      Advisor ⇔ everything else (unbound, orphaned binding, non-boolean or
--                missing claim, or no auth user at all).
--
--    The statement is deterministic and idempotent on re-apply. The role
--    guard trigger permits this write because the migration runs as a trusted
--    session (postgres). No binding, lifecycle state, or history is touched.
-- ---------------------------------------------------------------------------
UPDATE public.advisor AS a
   SET role = CASE
       WHEN EXISTS (
           SELECT 1 FROM auth.users AS u
            WHERE u.id = a.auth_user_id
              AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb
       ) THEN 'Admin'
       ELSE 'Advisor'
   END;

COMMENT ON COLUMN public.advisor.role IS
    'Protected display role (exactly Admin or Advisor). Presentation/audit state only — NEVER an RLS/RPC authorization input. Reconciled to the Auth app_metadata claim (Admin only when auth.users.raw_app_meta_data.ocf_admin is the JSON boolean true) and written only by trusted server-side provisioning (service_role/DBA) or the default at advisor creation.';