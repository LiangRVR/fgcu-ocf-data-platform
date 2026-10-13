-- ============================================================================
-- OCF Fellowship Management System — Serialize application re-links against a
-- concurrent parent archive
--
-- Forward-only, additive/replacement migration closing an independently-
-- reviewed concurrency finding on the `historical-audit-timeline` change:
--
--   TOCTOU ON APPLICATION RE-LINK. `public.update_application` (the
--   expected-version writer introduced by 20261015000001 and carried forward by
--   20261016000001) validates an actual parent re-link against the existing
--   ACTIVE-parent boundary by reading `student.archived_at` /
--   `fellowship.archived_at` with a plain, unlocked `NOT EXISTS`. Because the
--   definer path bypasses the invoker-security `guard_application_archive_parents`
--   trigger, nothing serialized that read against a concurrent
--   `public.lifecycle_transition` archive. A concurrent archive could therefore
--   commit AFTER the active-parent check but BEFORE the application UPDATE
--   committed, leaving the application re-linked to a parent that is archived at
--   commit time.
--
--   FIX. When (and only when) a re-link actually changes the parent reference,
--   the prospective parent row is now locked `FOR UPDATE` and its `archived_at`
--   is read under that lock BEFORE the check. A concurrent archive
--   (`public.lifecycle_transition`) takes `FOR UPDATE` on the same parent row,
--   so the two paths now serialize: the archive either commits first (and the
--   re-link observes the archived parent and is rejected with 42501) or waits
--   until the re-link commits (at which point the parent was still active).
--
--   DEADLOCK-FREE BY LOCK ORDER. The re-link acquires its locks in one fixed
--   order — application row first, then prospective student, then prospective
--   fellowship. The only other parent writer, `public.lifecycle_transition`,
--   locks exactly one parent row and never touches the application row, and no
--   code path locks a parent before an application. There is therefore no lock
--   cycle, so the added parent locks cannot deadlock.
--
--   PRESERVED UNCHANGED. Only the parent-validation block changes. The
--   expected-version precondition (`private.assert_expected_version`, 22023),
--   authorization (`public.is_active_advisor`, 42501), the stale conflict
--   (PT409), the no-relink historical re-save that keeps an archived parent
--   reference, the missing-row outcome (P0002), the permitted writable fields,
--   the return projection, the revoked direct authenticated UPDATE boundary, and
--   every ACL/RLS policy are identical to migration 20261016000001. The
--   REVOKE/GRANT pair is restated for self-documentation (CREATE OR REPLACE
--   preserves ownership and the existing ACL).
--
-- Forward-only; no existing business row, policy, grant, or audit row is
-- edited, deleted, or reset. No down migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_application(
    p_application_id integer,
    p_expected_version integer,
    p_student_id integer,
    p_fellowship_id integer,
    p_application_year integer,
    p_destination_country text,
    p_stage_of_application text,
    p_is_semi_finalist boolean,
    p_is_finalist boolean
)
RETURNS TABLE (
    application_id integer,
    student_id integer,
    fellowship_id integer,
    application_year smallint,
    destination_country character varying,
    stage_of_application character varying,
    is_semi_finalist boolean,
    is_finalist boolean,
    row_version integer,
    updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current integer;
    v_current_student integer;
    v_current_fellowship integer;
    v_parent_archived_at timestamptz;
BEGIN
    PERFORM private.assert_expected_version(p_expected_version);
    IF p_application_id IS NULL OR p_expected_version IS NULL THEN
        RAISE EXCEPTION 'update_application requires an application id and an expected version'
            USING ERRCODE = '22023';
    END IF;
    IF p_student_id IS NULL OR p_fellowship_id IS NULL
       OR p_stage_of_application IS NULL
       OR p_is_semi_finalist IS NULL OR p_is_finalist IS NULL THEN
        RAISE EXCEPTION 'update_application requires student_id, fellowship_id, stage, and finalist flags'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_active_advisor() THEN
        RAISE EXCEPTION 'only an authenticated active advisor may update an application'
            USING ERRCODE = '42501';
    END IF;

    SELECT a.row_version, a.student_id, a.fellowship_id
      INTO v_current, v_current_student, v_current_fellowship
      FROM public.application AS a
     WHERE a.application_id = p_application_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'application % does not exist', p_application_id
            USING ERRCODE = 'P0002';
    END IF;

    IF v_current IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'the application was changed by another session; refresh and review the latest data before saving'
            USING ERRCODE = 'PT409';
    END IF;

    -- Preserve the active-parent boundary for an actual re-link only.
    --
    -- The prospective parent is locked FOR UPDATE BEFORE it is validated, so a
    -- concurrent lifecycle archive (which locks the same row FOR UPDATE) must
    -- either commit before this lock is taken — and is then observed as
    -- archived — or wait until this re-link commits. Lock order is fixed
    -- (student before fellowship) and no other path locks a parent before an
    -- application, so no lock cycle (and therefore no deadlock) is possible.
    IF p_student_id IS DISTINCT FROM v_current_student THEN
        SELECT s.archived_at
          INTO v_parent_archived_at
          FROM public.student AS s
         WHERE s.student_id = p_student_id
         FOR UPDATE;

        IF NOT FOUND OR v_parent_archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'cannot link an application to archived or missing student %',
                p_student_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF p_fellowship_id IS DISTINCT FROM v_current_fellowship THEN
        SELECT f.archived_at
          INTO v_parent_archived_at
          FROM public.fellowship AS f
         WHERE f.fellowship_id = p_fellowship_id
         FOR UPDATE;

        IF NOT FOUND OR v_parent_archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'cannot link an application to archived or missing fellowship %',
                p_fellowship_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    UPDATE public.application AS a
       SET student_id = p_student_id,
           fellowship_id = p_fellowship_id,
           application_year = p_application_year,
           destination_country = p_destination_country,
           stage_of_application = p_stage_of_application,
           is_semi_finalist = p_is_semi_finalist,
           is_finalist = p_is_finalist
     WHERE a.application_id = p_application_id;

    RETURN QUERY
    SELECT a.application_id, a.student_id, a.fellowship_id,
           a.application_year, a.destination_country,
           a.stage_of_application, a.is_semi_finalist, a.is_finalist,
           a.row_version, a.updated_at
      FROM public.application AS a
     WHERE a.application_id = p_application_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) TO authenticated;

COMMENT ON FUNCTION public.update_application(
    integer, integer, integer, integer, integer, text, text, boolean, boolean
) IS
    'Active-advisor expected-version writer for an application: authorizes, locks the row, requires p_expected_version (PT409 on mismatch; 22023 on malformed), locks the prospective parent FOR UPDATE and validates an actual parent re-link against the ACTIVE parent boundary under that lock (so a concurrent archive serializes and can never leave a re-link pointing at an archived parent), writes the permitted explicit fields, and returns a display-safe projection with its new version. Direct authenticated UPDATE on application is revoked.';

-- ============================================================================
-- End of migration. Replacement function definition only; no existing business
-- row, column, policy, grant, or audit row is edited, deleted, or reset.
-- Forward-only.
-- ============================================================================
