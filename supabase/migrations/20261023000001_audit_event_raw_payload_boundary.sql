-- ============================================================================
-- OCF Fellowship Management System — DB-enforced raw audit JSON boundary
--
-- Forward-only migration ordered AFTER
-- 20261022000001_audit_activity_browser_safe.sql.
--
-- 20261022000001 removed the raw JSON snapshot columns from the browser-safe
-- `audit_activity` projection, but `authenticated` still held TABLE-level SELECT
-- on the RLS-governed `public.audit_event` base table. An authenticated active
-- advisor could therefore select `old_values`/`new_values`/`changes` directly
-- through PostgREST, bypassing the server normalizer: the "raw JSON never
-- leaves the server" boundary was a convention of the app projection, not a
-- database-enforced rule.
--
-- This migration makes it an actual database-enforced boundary:
--
--   * `authenticated` TABLE-level SELECT on `public.audit_event` is REVOKED, so
--     no client role can select an arbitrary/`*` column set (and therefore the
--     raw payload columns) from the base table.
--   * `authenticated` is granted COLUMN-level SELECT on EXACTLY the columns the
--     `security_invoker` `audit_activity` view references -- nothing more. The
--     view keeps working under the invoker's own privileges (the active-advisor
--     `audit_event` RLS still governs the rows), while
--     `old_values`/`new_values`/`changes` become unreadable to every client
--     role.
--   * The raw diff required by the safe presentation layer is fetched ONLY by
--     server-only service-role code (`lib/supabase/admin.ts`), AFTER the
--     cookie/RLS safe-view query has already authorized and bounded the audit
--     ids -- so the raw JSON never reaches the browser.
--
-- Preserved unchanged: the `audit_activity` view (security_invoker, explicit
-- safe columns), the `audit_event` active-advisor RLS policy, the
-- `audit_event_subject` ACL/RLS, every write path, and `service_role` (which
-- keeps full base-table SELECT for the server-only raw-diff read). No audit row
-- is written and no other migration, grant, policy, or view is changed.
-- Forward-only; no down migration.
-- ============================================================================


-- ============================================================================
-- 1. Revoke table-level SELECT from `authenticated` so an unqualified/`*`
--    select -- and therefore the raw `old_values`/`new_values`/`changes`
--    payloads -- is denied, then re-grant SELECT on ONLY the non-raw columns the
--    security_invoker `audit_activity` view reads.
--
--    An explicit column-level REVOKE of the three raw payload columns is issued
--    first as a fail-closed guard: it makes the raw columns unreadable even if a
--    future migration ever granted them, and documents the intent at the column
--    boundary. `anon`/`PUBLIC` already hold no privilege (revoked in
--    20261012000001) and remain fully revoked.
-- ============================================================================
REVOKE SELECT ON public.audit_event FROM authenticated;
REVOKE SELECT (old_values, new_values, changes) ON public.audit_event FROM authenticated;

GRANT SELECT (
    audit_id,
    occurred_at,
    entity_type,
    entity_id,
    action,
    actor_advisor_id,
    actor_name_snapshot,
    reason,
    origin,
    subject_student_id,
    subject_application_id,
    subject_fellowship_id
) ON public.audit_event TO authenticated;

COMMENT ON TABLE public.audit_event IS
    'Immutable, database-authored audit read model for the current-state student, fellowship, and application rows. Events are written only by the internal SECURITY DEFINER trigger helper inside the source mutation transaction; baseline rows are intentionally never fabricated. The client role `authenticated` holds COLUMN-level SELECT only on the non-raw event context columns (audit_id/occurred_at/entity_type/entity_id/action/actor_advisor_id/actor_name_snapshot/reason/origin/subject_*), so the raw snapshot payloads (`old_values`/`new_values`/`changes`) are unreadable to every client role and are fetched only by server-only service-role code. Rows stay governed by the active-advisor RLS; immutable to all product roles including Admin.';

-- ============================================================================
-- End of migration. Forward-only; `audit_event`, the immutable base/amendment
-- rows, the `audit_activity` projection, and the effective operational views are
-- never written here, and no existing migration, policy, or view is removed.
-- Re-running the migration chain re-applies this idempotent privilege
-- tightening, so it is safe to replay as part of the forward chain.
-- ============================================================================
