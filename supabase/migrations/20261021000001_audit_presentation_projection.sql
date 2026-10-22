-- ============================================================================
-- OCF Fellowship Management System — Safe audit presentation projection
--
-- Forward-only migration ordered AFTER
-- 20261020000001_complete_immutable_history_context.sql. It completes the
-- immutable audit presentation source so application reads can build the
-- approved human-facing history without raw snapshot payloads, without mutable
-- joins, and without per-event follow-up queries:
--
--   1. RELATIONSHIP ENDPOINT IDS. The `security_invoker` `audit_activity`
--      view is extended (columns appended) with the immutable paired endpoint
--      ids (`previous_student_id`/`current_student_id`,
--      `previous_fellowship_id`/`current_fellowship_id`) so a re-link can
--      present `Student #id`/`Fellowship #id` fallbacks when the frozen label
--      is absent. Names continue to read only frozen
--      `audit_event_subject.subject_name_snapshot` values.
--
--   2. FELLOWSHIP THURSDAY PREDECESSOR SCALARS. For a
--      `fellowship_thursday_amendment` event the view derives, per corrected
--      field INDEPENDENTLY, the effective value immediately BEFORE the
--      amendment and the value AFTER it, from the immutable base row plus the
--      strictly-earlier amendments ordered by `(created_at, amendment_id)`.
--      An explicit correction-to-NULL is representable (the explicit
--      `corrects_source_info` flag distinguishes "leave unchanged" from "set
--      to NULL"); a later amendment never rewrites an older event's meaning.
--
--   3. SCHOLARSHIP VOID REASON. A `scholarship_history_amendment` Void event
--      projects ONLY that exact amendment's required `reason` as `void_reason`
--      (the amendment id is the event's immutable `entity_id`). No other
--      amendment reason/details/narrative text is selected anywhere.
--
--   4. SAFE ADVISING PARENT SCALARS. An `advising_meeting_amendment` event
--      projects the immutable parent (append-only) meeting's `meeting_date`,
--      `application_id`, and `advisor_id` from the `advising_meeting` row so
--      the correction can present the meeting date, the historical
--      application, and the conducting advisor as a neutral `Advisor #id`.
--      The view never joins `public.advisor` for a name and never reads the
--      current mutable application; the frozen application label remains the
--      parent creation-event `subject_application_name` snapshot.
--
-- One row per `audit_event` is preserved. Every new scalar is set-based
-- (correlated/lateral to unique keys only) so a history read stays a single
-- bounded query with no per-event application round trip. The view retains
-- `security_invoker = on`, the existing active-advisor audit RLS, and
-- `authenticated` SELECT-only. This migration neither writes nor modifies any
-- audit/base/amendment row and touches no existing migration, policy, grant,
-- or effective operational view. Forward-only; no down migration.
-- ============================================================================


-- ============================================================================
-- 1. Explicit-column, SECURITY INVOKER presentation-source view
--
-- Column order is preserved from 20261020000001 and the presentation scalars
-- are APPENDED, which is what `CREATE OR REPLACE VIEW` requires (same leading
-- columns, new columns only at the end).
-- ============================================================================
CREATE OR REPLACE VIEW public.audit_activity
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
    ae.old_values,
    ae.new_values,
    ae.changes,
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
    'Explicit-column, read-only, SECURITY INVOKER audit activity presentation source. Exposes audit-safe event fields plus frozen relationship-aware labels/ids resolved from immutable audit_event_subject snapshots; per-field Fellowship Thursday predecessor/current effective values derived from the immutable base row and strictly-earlier amendments; the exact Scholarship Void reason only for voided scholarship_history_amendment events; and the immutable parent advising-meeting meeting_date/application_id/advisor_id for advising_meeting_amendment events. Actor context is the frozen actor_name_snapshot (never a live advisor join); no Auth-binding/private/raw-reason column is exposed beyond the explicitly approved Void reason. One row per audit_event; remains governed by the underlying active-advisor audit RLS.';

REVOKE ALL ON public.audit_activity FROM anon, authenticated;
GRANT SELECT ON public.audit_activity TO authenticated;

-- ============================================================================
-- End of migration. Forward-only; `audit_event`, the immutable base/amendment
-- rows, and the effective operational views are never written here, and no
-- existing migration, policy, or grant is removed.
-- ============================================================================
