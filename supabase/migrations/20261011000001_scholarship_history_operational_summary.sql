-- ============================================================================
-- OCF Fellowship Management System — Scholarship History operational summary
--
-- Forward-only, additive migration for AI-DLC change
-- `server-side-pagination-and-querying` (oracle P1 remediation). It adds one
-- narrowly scoped aggregate function so the Scholarship History page can obtain
-- its operational (non-void) award/student totals under the SAME search and
-- fellowship filters as the paginated list WITHOUT transferring a wide,
-- unbounded row set to the application and reducing it in the client.
--
-- Before: the page issued `select("student_id").eq("is_voided", false)` (up to
-- the whole authorized relation) and built a JavaScript `Set` to derive the
-- distinct-student count. The transfer was unbounded, and the projection still
-- materialized every matching student_id in the Node process.
--
-- After: one function call returns exactly two integers for the whole filtered
-- relation; the database performs the `count(*)`/`count(DISTINCT ...)`
-- aggregate and no rows are shipped over PostgREST.
--
-- Guarantees (same trust boundary as the SECURITY INVOKER list views):
--   * SECURITY INVOKER — the function executes with the requesting role's
--     privileges and reads the existing `public.scholarship_history_list`
--     SECURITY INVOKER view, so every underlying RLS policy still applies to
--     the aggregated rows. It can NEVER bypass RLS and is never service-role.
--   * Empty `search_path` — every object is schema-qualified and the caller's
--     `search_path` cannot influence resolution.
--   * Read-only/stable — the body is a single aggregate SELECT; no writes, no
--     side effects. `STABLE` documents the within-statement stability.
--   * Same filter semantics as the list loader — `is_voided = false` plus the
--     caller-supplied escaped ILIKE pattern and optional effective
--     `fellowship_id`. Corrected awards are counted under their effective
--     program (the list view already resolves that), and a Void contributes to
--     neither total.
--   * Least privilege — EXECUTE is revoked from PUBLIC and `anon` and granted
--     only to `authenticated`, matching the list views.
--
-- Rollback: additive and unused by any write path; dropping the function is a
-- separate forward migration and code rollback can simply restore the former
-- reader. No down migration is provided.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.scholarship_history_operational_summary(
    p_search text DEFAULT NULL,
    p_fellowship_id integer DEFAULT NULL
)
RETURNS TABLE (
    total_records bigint,
    distinct_students bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT
        count(*)::bigint AS total_records,
        count(DISTINCT h.student_id)::bigint AS distinct_students
      FROM public.scholarship_history_list h
     WHERE h.is_voided = false
       AND (p_search IS NULL OR h.student_name ILIKE p_search)
       AND (p_fellowship_id IS NULL OR h.fellowship_id = p_fellowship_id);
$$;

REVOKE ALL ON FUNCTION public.scholarship_history_operational_summary(text, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.scholarship_history_operational_summary(text, integer)
    TO authenticated;

COMMENT ON FUNCTION public.scholarship_history_operational_summary(text, integer) IS
    'RLS-preserving SECURITY INVOKER operational aggregate for Scholarship History: returns the exact non-void award count and distinct-student count over the SAME search (escaped ILIKE pattern) and effective fellowship filter as the paginated list, without shipping rows to the client. Reads only public.scholarship_history_list; never service-role and never bypasses RLS. EXECUTE granted to authenticated only.';
