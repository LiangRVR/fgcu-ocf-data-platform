-- ============================================================================
-- OCF Fellowship Management System — Browser-safe audit activity boundary
--
-- Forward-only migration ordered AFTER
-- 20261021000001_audit_presentation_projection.sql. It makes the app's history
-- projection an ACTUAL browser-safe read boundary:
--
--   `public.audit_activity` is GRANTed SELECT to `authenticated`, so a browser
--   can reach it directly through PostgREST. Until now it carried the raw audit
--   JSON snapshot columns (`old_values`, `new_values`, `changes`), so the app's
--   own projection let an authenticated browser client select raw audit JSON and
--   bypass the server normalizer. This migration removes those three raw payload
--   columns from the projection. The view retains:
--
--     * `security_invoker = on` (the underlying active-advisor `audit_event` RLS
--       fully governs which rows are visible — no RLS weakening, no `FORCE RLS`
--       change, no service-role read path);
--     * exactly one row per `audit_event`;
--     * the full explicit safe-column surface (event identity/context, frozen
--       relationship labels and endpoint ids, the per-field Fellowship Thursday
--       predecessor/current scalars, the exact Scholarship Void reason, and the
--       immutable advising parent scalars) unchanged.
--
-- The raw diff needed for the safe presentation layer is no longer exposed on any
-- authenticated-readable projection. The server normalizer reads it directly
-- from the RLS-governed `public.audit_event` base table, exactly like the app's
-- other reads over RLS-protected bases, and keeps the raw JSON server-side.
--
-- `CREATE OR REPLACE VIEW` cannot DROP columns, so the view is dropped and
-- recreated with the same leading columns minus the three raw payloads. The
-- existing active-advisor audit RLS is untouched (audit_event policies/grants
-- are not modified here), no audit/base/amendment row is written, and no other
-- migration, policy, grant, or effective operational view is changed.
-- Forward-only; no down migration.
-- ============================================================================


-- ============================================================================
-- 1. Recreate the explicit-column, SECURITY INVOKER projection WITHOUT the raw
--    audit JSON payloads (`old_values`/`new_values`/`changes`). Column order
--    otherwise matches 20261021000001.
-- ============================================================================
DROP VIEW IF EXISTS public.audit_activity;

CREATE VIEW public.audit_activity
WITH (security_invoker = on)
AS
SELECT
    ae.audit_id,
    ae.occurred_at,
    ae.entity_type,
    ae.entity_id,
    ae.action,
    ae.actor_advisor_id,
    ae.actor_name_snapshot,
    ae.reason,
    ae.origin,
    ae.subject_student_id,
    ae.subject_application_id,
    ae.subject_fellowship_id,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'))::character varying AS student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'))::character varying AS fellowship_name,
    ARRAY(SELECT aes.subject_id FROM public.audit_event_subject AS aes
           WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
           ORDER BY aes.subject_id, aes.relationship) AS student_subject_ids,
    ARRAY(SELECT aes.subject_id FROM public.audit_event_subject AS aes
           WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
           ORDER BY aes.subject_id, aes.relationship) AS fellowship_subject_ids,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
         AND aes.relationship = 'previous'))::character varying AS previous_student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
         AND aes.relationship = 'current'))::character varying AS current_student_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
         AND aes.relationship = 'previous'))::character varying AS previous_fellowship_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
         AND aes.relationship = 'current'))::character varying AS current_fellowship_name,
    ((SELECT string_agg(DISTINCT aes.subject_name_snapshot, ' | ' ORDER BY aes.subject_name_snapshot)
        FROM public.audit_event_subject AS aes
       WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'application'
         AND aes.relationship = 'subject'))::character varying AS subject_application_name,
    -- Paired frozen relationship endpoint ids (explicit `#id` fallbacks).
    (SELECT aes.subject_id FROM public.audit_event_subject AS aes
      WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
        AND aes.relationship = 'previous'
      ORDER BY aes.subject_id
      LIMIT 1) AS previous_student_id,
    (SELECT aes.subject_id FROM public.audit_event_subject AS aes
      WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'student'
        AND aes.relationship = 'current'
      ORDER BY aes.subject_id
      LIMIT 1) AS current_student_id,
    (SELECT aes.subject_id FROM public.audit_event_subject AS aes
      WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
        AND aes.relationship = 'previous'
      ORDER BY aes.subject_id
      LIMIT 1) AS previous_fellowship_id,
    (SELECT aes.subject_id FROM public.audit_event_subject AS aes
      WHERE aes.audit_id = ae.audit_id AND aes.subject_type = 'fellowship'
        AND aes.relationship = 'current'
      ORDER BY aes.subject_id
      LIMIT 1) AS current_fellowship_id,
    -- Fellowship Thursday per-field predecessor/current effective values.
    ftc.attended_before AS fellowship_thursday_attended_before,
    ftc.attended_after  AS fellowship_thursday_attended_after,
    ftc.attended_amended AS fellowship_thursday_attended_amended,
    ftc.source_before AS fellowship_thursday_source_before,
    ftc.source_after  AS fellowship_thursday_source_after,
    ftc.source_amended AS fellowship_thursday_source_amended,
    -- Exact Scholarship Void reason (only that amendment's required reason).
    voidc.void_reason,
    -- Immutable parent advising-meeting structural scalars.
    advc.meeting_date AS advising_meeting_date,
    advc.application_id AS advising_application_id,
    advc.advisor_id AS advising_advisor_id
  FROM public.audit_event AS ae
  -- Fellowship Thursday amendment predecessor/current resolution. The event's
  -- immutable entity_id IS the amendment id; base + strictly-earlier
  -- amendments are read per corrected field independently.
  LEFT JOIN LATERAL (
      SELECT
          CASE WHEN att.found THEN att.val ELSE ft.attended END AS attended_before,
          COALESCE(a.corrected_attended,
                   CASE WHEN att.found THEN att.val ELSE ft.attended END) AS attended_after,
          (a.corrected_attended IS NOT NULL) AS attended_amended,
          CASE WHEN src.found THEN src.val ELSE ft.source_info END AS source_before,
          CASE WHEN a.corrects_source_info
               THEN a.corrected_source_info
               ELSE CASE WHEN src.found THEN src.val ELSE ft.source_info END
          END AS source_after,
          a.corrects_source_info AS source_amended
        FROM public.fellowship_thursday_amendment AS a
        JOIN public.fellowship_thursday AS ft ON ft.attendance_id = a.attendance_id
        LEFT JOIN LATERAL (
            SELECT a2.corrected_attended AS val, TRUE AS found
              FROM public.fellowship_thursday_amendment AS a2
             WHERE a2.attendance_id = a.attendance_id
               AND a2.corrected_attended IS NOT NULL
               AND (a2.created_at, a2.amendment_id) < (a.created_at, a.amendment_id)
             ORDER BY a2.created_at DESC, a2.amendment_id DESC
             LIMIT 1
        ) AS att ON TRUE
        LEFT JOIN LATERAL (
            SELECT a2.corrected_source_info AS val, TRUE AS found
              FROM public.fellowship_thursday_amendment AS a2
             WHERE a2.attendance_id = a.attendance_id
               AND a2.corrects_source_info
               AND (a2.created_at, a2.amendment_id) < (a.created_at, a.amendment_id)
             ORDER BY a2.created_at DESC, a2.amendment_id DESC
             LIMIT 1
        ) AS src ON TRUE
       WHERE ae.entity_type = 'fellowship_thursday_amendment'
         AND a.amendment_id = ae.entity_id
  ) AS ftc ON TRUE
  -- Exact Scholarship Void reason bound to the event's own amendment id.
  LEFT JOIN LATERAL (
      SELECT a.reason AS void_reason
        FROM public.scholarship_history_amendment AS a
       WHERE ae.entity_type = 'scholarship_history_amendment'
         AND a.amendment_id = ae.entity_id
         AND a.amendment_type = 'Void'
  ) AS voidc ON TRUE
  -- Immutable parent advising-meeting scalars (append-only, never mutable).
  LEFT JOIN LATERAL (
      SELECT am.meeting_date, am.application_id, am.advisor_id
        FROM public.advising_meeting_amendment AS a
        JOIN public.advising_meeting AS am ON am.meeting_id = a.meeting_id
       WHERE ae.entity_type = 'advising_meeting_amendment'
         AND a.amendment_id = ae.entity_id
  ) AS advc ON TRUE;

COMMENT ON VIEW public.audit_activity IS
    'Browser-safe, explicit-column, read-only, SECURITY INVOKER audit activity projection. Exposes only audit-safe event identity/context plus frozen relationship-aware labels/ids resolved from immutable audit_event_subject snapshots; the per-field Fellowship Thursday predecessor/current effective values derived from the immutable base row and strictly-earlier amendments; the exact Scholarship Void reason only for voided scholarship_history_amendment events; and the immutable parent advising-meeting meeting_date/application_id/advisor_id for advising_meeting_amendment events. The raw audit JSON payloads (old_values/new_values/changes) are deliberately NOT exposed, so an authenticated browser client cannot select raw audit JSON through this projection; the server-only normalizer reads the raw diff from the RLS-governed audit_event base table. One row per audit_event; remains governed by the underlying active-advisor audit RLS (security_invoker).';

REVOKE ALL ON public.audit_activity FROM anon, authenticated;
GRANT SELECT ON public.audit_activity TO authenticated;

-- ============================================================================
-- End of migration. Forward-only; `audit_event`, the immutable base/amendment
-- rows, and the effective operational views are never written here, and no
-- existing migration, policy, or grant is removed. Re-running the migration
-- chain re-drops and re-creates this projection (the guarded DROP above), so it
-- is safe to replay as part of the forward chain.
-- ============================================================================
