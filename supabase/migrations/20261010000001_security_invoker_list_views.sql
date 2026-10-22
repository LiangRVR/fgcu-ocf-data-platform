-- ============================================================================
-- OCF Fellowship Management System — Read-only SECURITY INVOKER list views
--
-- Forward-only, additive migration for AI-DLC change
-- `server-side-pagination-and-querying`, Plan Work 3. It adds one flattened,
-- explicit-column, read-only list view per operational list so the server-side
-- pagination loaders (Works 4–9) can apply search/filter/sort/count against a
-- single RLS-preserving relation instead of embedding root+relation filters.
--
-- Views (names are the stable contract consumed by the per-list loaders):
--   * public.student_list
--   * public.application_list
--   * public.advising_meeting_list
--   * public.fellowship_thursday_list
--   * public.scholarship_history_list
--   * public.fellowship_list
--
-- Guarantees:
--   * SECURITY INVOKER — every underlying-table RLS policy (row visibility for
--     the rows AND for correlated subqueries/counts) still applies to the
--     requesting role; a view can never bypass RLS.
--   * Explicit columns only — no `SELECT *`. Auth binding/private advisor
--     fields (`advisor.auth_user_id`, `advisor.email`, `advisor.role`) are
--     never exposed; advisor context is limited to display names.
--   * Read-only surface — no INSERT/UPDATE/DELETE: ALL privileges are revoked
--     from `anon` and `authenticated`, and only `authenticated` receives
--     SELECT (the Supabase default ACL otherwise hands new relations full
--     `authenticated` DML). No existing RLS policy, grant on a base table,
--     write path, lifecycle RPC, or index is touched.
--   * Corrected/void-aware history — Fellowship Thursday and Scholarship
--     History read the existing SECURITY INVOKER effective views, so
--     corrections never appear as extra rows and a Voided award stays
--     auditable (`is_voided`) without being counted operationally.
--   * General Advising preserved — a meeting with `application_id IS NULL`
--     yields NULL application/fellowship context, never a fabricated program.
--   * No row multiplication — relational context and aggregate metrics are
--     resolved with correlated scalar subqueries / EXISTS over unique keys,
--     never with a join that can duplicate a parent list row.
--
-- Ordering note: the migration filename is pinned to the next forward-only
-- slot (20261010000001) rather than the CLI's creation timestamp, because this
-- change depends on the `effective_*` views created by 20261008000001; an
-- earlier filename would make a fresh `supabase db reset` fail.
--
-- Rollback: the views are additive and unused by any write path; dropping them
-- is a separate forward migration, and code rollback can simply stop reading
-- them. No down migration is provided.
-- ============================================================================


-- ============================================================================
-- 1. public.student_list
--
-- Explicit student columns required by the roster list/search/filter/export,
-- plus the three independently-derived exception flags the roster's active
-- workflow views depend on:
--   * has_application — the student has at least one application row;
--   * has_advising    — the student has at least one advising meeting;
--   * has_prior_award — the student has at least one NON-voided effective
--                       scholarship award (voids are excluded from the
--                       operational prior-award queue but remain auditable on
--                       the scholarship-history surface).
-- Archived students are NOT filtered here: the loader applies the active
-- (`archived_at IS NULL`) or explicit archive-view predicate so every
-- historical relationship is preserved.
-- ============================================================================
CREATE OR REPLACE VIEW public.student_list
WITH (security_invoker = on)
AS
SELECT
    s.student_id,
    s.full_name,
    s.is_ch_student,
    s.email,
    s.major,
    s.minor,
    s.gpa,
    s.class_standing,
    s.us_citizen,
    s.age,
    s.gender,
    s.pronouns,
    s.race_ethnicity,
    s.languages,
    s.first_gen,
    s.honors_college,
    s.archived_at,
    EXISTS (
        SELECT 1
          FROM public.application a
         WHERE a.student_id = s.student_id
    ) AS has_application,
    EXISTS (
        SELECT 1
          FROM public.advising_meeting m
         WHERE m.student_id = s.student_id
    ) AS has_advising,
    EXISTS (
        SELECT 1
          FROM public.effective_scholarship_history h
         WHERE h.student_id = s.student_id
           AND h.is_voided = false
    ) AS has_prior_award
FROM public.student s;

COMMENT ON VIEW public.student_list IS
    'Explicit-column, read-only, SECURITY INVOKER student roster source for server-side list pagination. Carries archived_at plus the has_application/has_advising/has_prior_award exception flags (prior award excludes voided effective awards). No Auth binding data.';

REVOKE ALL ON public.student_list FROM anon, authenticated;
GRANT SELECT ON public.student_list TO authenticated;


-- ============================================================================
-- 2. public.application_list
--
-- Explicit application columns required by the pipeline list/search/filter,
-- with the student and fellowship display names resolved by correlated scalar
-- subqueries over their unique keys (no row multiplication). Archived related
-- entities keep their names: historical context is never dropped.
-- ============================================================================
CREATE OR REPLACE VIEW public.application_list
WITH (security_invoker = on)
AS
SELECT
    a.application_id,
    a.student_id,
    a.fellowship_id,
    a.application_year,
    a.destination_country,
    a.stage_of_application,
    a.is_semi_finalist,
    a.is_finalist,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = a.student_id
    ) AS student_name,
    (
        SELECT f.fellowship_name
          FROM public.fellowship f
         WHERE f.fellowship_id = a.fellowship_id
    ) AS fellowship_name
FROM public.application a;

COMMENT ON VIEW public.application_list IS
    'Explicit-column, read-only, SECURITY INVOKER application pipeline source for server-side list pagination, with flattened student_name/fellowship_name resolved without row multiplication. No Auth binding data.';

REVOKE ALL ON public.application_list FROM anon, authenticated;
GRANT SELECT ON public.application_list TO authenticated;


-- ============================================================================
-- 3. public.advising_meeting_list
--
-- Explicit meeting columns plus flattened student/advisor/recorder/application/
-- fellowship context. All relational context is resolved with correlated
-- scalar subqueries; `auth_user_id` and other private advisor fields are never
-- selected — only advisor display names.
--
-- General Advising: when `application_id IS NULL` all of application_year,
-- fellowship_id, and fellowship_name are NULL (each subquery matches no row),
-- so the loader can distinguish General Advising without misattributing a
-- fellowship. The composite application/student FK guarantees any resolved
-- context belongs to the meeting's own student.
-- ============================================================================
CREATE OR REPLACE VIEW public.advising_meeting_list
WITH (security_invoker = on)
AS
SELECT
    m.meeting_id,
    m.student_id,
    m.advisor_id,
    m.application_id,
    m.meeting_date,
    m.meeting_mode,
    m.no_show,
    m.notes,
    m.created_at,
    m.created_by_advisor_id,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = m.student_id
    ) AS student_name,
    (
        SELECT ad.advisor_name
          FROM public.advisor ad
         WHERE ad.advisor_id = m.advisor_id
    ) AS advisor_name,
    (
        SELECT cb.advisor_name
          FROM public.advisor cb
         WHERE cb.advisor_id = m.created_by_advisor_id
    ) AS recorded_by_advisor_name,
    (
        SELECT a.application_year
          FROM public.application a
         WHERE a.application_id = m.application_id
    ) AS application_year,
    (
        SELECT a.fellowship_id
          FROM public.application a
         WHERE a.application_id = m.application_id
    ) AS fellowship_id,
    (
        SELECT f.fellowship_name
          FROM public.application a
          JOIN public.fellowship f ON f.fellowship_id = a.fellowship_id
         WHERE a.application_id = m.application_id
    ) AS fellowship_name
FROM public.advising_meeting m;

COMMENT ON VIEW public.advising_meeting_list IS
    'Explicit-column, read-only, SECURITY INVOKER advising list source with flattened student/advisor/recorder and application/fellowship context. General Advising (application_id IS NULL) yields NULL application/fellowship context. Never exposes advisor Auth bindings.';

REVOKE ALL ON public.advising_meeting_list FROM anon, authenticated;
GRANT SELECT ON public.advising_meeting_list TO authenticated;


-- ============================================================================
-- 4. public.fellowship_thursday_list
--
-- Reads the shared effective_fellowship_thursday view so the operational
-- attendance list follows the newest applicable correction per field and
-- corrections are never counted as extra attendance rows. The base values stay
-- readable for the audit trail, and the display name is resolved without a
-- join that could multiply rows.
-- ============================================================================
CREATE OR REPLACE VIEW public.fellowship_thursday_list
WITH (security_invoker = on)
AS
SELECT
    e.attendance_id,
    e.student_id,
    e.base_attended,
    e.base_source_info,
    e.attended,
    e.source_info,
    e.has_amendments,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = e.student_id
    ) AS student_name
FROM public.effective_fellowship_thursday e;

COMMENT ON VIEW public.fellowship_thursday_list IS
    'Explicit-column, read-only, SECURITY INVOKER Fellowship Thursday list source backed by the effective-value view: one row per attendance with corrected attended/source values and base audit values. No Auth binding data.';

REVOKE ALL ON public.fellowship_thursday_list FROM anon, authenticated;
GRANT SELECT ON public.fellowship_thursday_list TO authenticated;


-- ============================================================================
-- 5. public.scholarship_history_list
--
-- Reads the shared effective_scholarship_history view so the displayed award
-- program is the corrected effective fellowship_id, `is_voided` is available
-- for the audit surface, and a Void does not duplicate or inflate the row.
-- Voided awards remain listed (auditable); operational counts exclude them via
-- `is_voided`. Display names are resolved by correlated scalar subqueries.
-- ============================================================================
CREATE OR REPLACE VIEW public.scholarship_history_list
WITH (security_invoker = on)
AS
SELECT
    e.history_id,
    e.student_id,
    e.base_fellowship_id,
    e.fellowship_id,
    e.has_correction,
    e.is_voided,
    e.voided_at,
    (
        SELECT s.full_name
          FROM public.student s
         WHERE s.student_id = e.student_id
    ) AS student_name,
    (
        SELECT f.fellowship_name
          FROM public.fellowship f
         WHERE f.fellowship_id = e.fellowship_id
    ) AS fellowship_name
FROM public.effective_scholarship_history e;

COMMENT ON VIEW public.scholarship_history_list IS
    'Explicit-column, read-only, SECURITY INVOKER Scholarship History list source backed by the effective-value view: corrected effective fellowship_id, base_fellowship_id for audit, has_correction/is_voided/voided_at, and flattened student/fellowship names. No Auth binding data.';

REVOKE ALL ON public.scholarship_history_list FROM anon, authenticated;
GRANT SELECT ON public.scholarship_history_list TO authenticated;


-- ============================================================================
-- 6. public.fellowship_list
--
-- Explicit fellowship columns plus the independently-derived application
-- metrics required by the program list (total applications, finalists,
-- awarded outcomes, and an existence flag). Every metric is a correlated
-- scalar subquery over application.fellowship_id, so the parent fellowship row
-- is never multiplied. Archived fellowships are not filtered here; the loader
-- applies the active/archive-view predicate.
-- ============================================================================
CREATE OR REPLACE VIEW public.fellowship_list
WITH (security_invoker = on)
AS
SELECT
    f.fellowship_id,
    f.fellowship_name,
    f.archived_at,
    (
        SELECT count(*)::integer
          FROM public.application a
         WHERE a.fellowship_id = f.fellowship_id
    ) AS total_applications,
    (
        SELECT count(*)::integer
          FROM public.application a
         WHERE a.fellowship_id = f.fellowship_id
           AND a.is_finalist = true
    ) AS finalists,
    (
        SELECT count(*)::integer
          FROM public.application a
         WHERE a.fellowship_id = f.fellowship_id
           AND a.stage_of_application = 'Awarded'
    ) AS awarded_students,
    EXISTS (
        SELECT 1
          FROM public.application a
         WHERE a.fellowship_id = f.fellowship_id
    ) AS has_applications
FROM public.fellowship f;

COMMENT ON VIEW public.fellowship_list IS
    'Explicit-column, read-only, SECURITY INVOKER fellowship catalog source with per-program application metrics (total_applications, finalists, awarded_students, has_applications) resolved by correlated counts without row multiplication. No Auth binding data.';

REVOKE ALL ON public.fellowship_list FROM anon, authenticated;
GRANT SELECT ON public.fellowship_list TO authenticated;
