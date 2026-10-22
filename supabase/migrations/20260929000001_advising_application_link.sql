-- ============================================================================
-- OCF Fellowship Management System — Advising ↔ Application Link + Metadata
--
-- Forward-only, additive schema migration (AI-DLC change
-- 2026-09-29-advising-application-link, approved design). Extends the
-- normalized model so a meeting can be scoped to one of a student's
-- application cycles and so every new meeting carries immutable, database-
-- authored creation metadata:
--
--   fellowship (fellowship_name)
--         ^
-- application (student_id, fellowship_id, application_year)
--         ^
-- advising_meeting (student_id, application_id nullable)
--
--   1. adds nullable `application.application_year SMALLINT` — the explicit
--      application cycle. Existing rows keep NULL (the cycle is unknown for
--      legacy records and is NEVER inferred);
--   2. adds `UNIQUE (application_id, student_id)` on `application` solely as
--      the target for the child composite FK below. No
--      (student_id, fellowship_id, application_year) uniqueness rule is added;
--   3. adds nullable `advising_meeting.application_id INTEGER` with a direct
--      FK to `application(application_id)` AND a composite FK
--      `(application_id, student_id)` to `application(application_id,
--      student_id)`: the direct FK satisfies the relationship contract while
--      the composite FK makes a cross-student application impossible at the
--      database boundary. NULL `application_id` = General Advising and passes
--      both FKs (NULL columns are never matched by a foreign key);
--   4. adds `advising_meeting.created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
--      and nullable `created_by_advisor_id INTEGER` FK to `advisor`.
--      Existing rows receive the migration-time timestamp (documented
--      migration-time metadata, never a fabricated original entry time) and
--      keep a NULL creator;
--   5. adds advising indexes: a single-column `application_id` index for
--      application lifecycle/delete lookup and a `(student_id, application_id)`
--      composite index for advising queries and the composite relationship;
--   6. adds a hardened non-RPC metadata trigger/function: on EVERY INSERT the
--      trigger — never the payload — is authoritative for creation metadata.
--      `created_by_advisor_id` is unconditionally set to the ACTIVE advisor
--      whose `auth_user_id = auth.uid()` resolves (NULL when no JWT/technical
--      session is present) and `created_at := now()` is always stamped, so a
--      client-supplied creator/time is never retained; UPDATE changes to
--      either metadata field are rejected fail-closed. The function is
--      SECURITY DEFINER with an empty search_path, fully qualified relations,
--      and EXECUTE revoked from exposed roles. `advisor_id` (the advisor who
--      conducted the meeting) is never touched.
--
-- Forward-only: no existing migration, table, column, row, or RLS policy is
-- edited, deleted, or reset.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. application.application_year (nullable application cycle)
--
-- A SMALLINT cycle, NOT a creation year and NOT a fellowship attribute.
-- Nullable so every existing row stays truthful when its cycle is unknown;
-- nothing here invents a value for historic rows.
-- ---------------------------------------------------------------------------
ALTER TABLE public.application
    ADD COLUMN IF NOT EXISTS application_year smallint;

COMMENT ON COLUMN public.application.application_year IS
    'Application cycle (e.g. 2026), not the row creation year and not a fellowship attribute. NULL for legacy records whose cycle is unknown.';

-- ---------------------------------------------------------------------------
-- 2. application UNIQUE (application_id, student_id)
--
-- The composite target for the advising_meeting composite FK. application_id
-- is already unique as the primary key, but an explicit unique key on the
-- exact (application_id, student_id) column pair is required so the child
-- composite FK can reference both columns as one key.
-- ---------------------------------------------------------------------------
ALTER TABLE public.application
    ADD CONSTRAINT application_application_id_student_id_key
        UNIQUE (application_id, student_id);

-- ---------------------------------------------------------------------------
-- 3. advising_meeting.application_id + direct and composite FKs
--
-- `application_id INTEGER NULL` is General Advising when NULL. The direct FK
-- satisfies the application relationship contract; the composite FK
-- (application_id, student_id) → application(application_id, student_id)
-- independently rejects any reference to another student's application, so
-- client-side filtering is never the integrity control.
-- ---------------------------------------------------------------------------
ALTER TABLE public.advising_meeting
    ADD COLUMN IF NOT EXISTS application_id integer;

ALTER TABLE public.advising_meeting
    ADD CONSTRAINT advising_meeting_application_id_fkey
        FOREIGN KEY (application_id) REFERENCES public.application (application_id),
    ADD CONSTRAINT advising_meeting_application_student_fkey
        FOREIGN KEY (application_id, student_id)
        REFERENCES public.application (application_id, student_id);

COMMENT ON COLUMN public.advising_meeting.application_id IS
    'The student application this advising session concerned; NULL means General Advising. The composite FK (application_id, student_id) enforces that the application belongs to the meeting''s student.';

-- ---------------------------------------------------------------------------
-- 4. advising_meeting creation metadata
--
-- `created_at` is NOT NULL with a DB default: PostgreSQL stamps existing rows
-- with the migration time (documented metadata) and every new row with now().
-- `created_by_advisor_id` stays nullable so legacy rows and trusted technical
-- (service-role/seed) writes remain NULL; the metadata trigger is the ONLY
-- path that writes a creator for authenticated browser inserts.
-- ---------------------------------------------------------------------------
ALTER TABLE public.advising_meeting
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS created_by_advisor_id integer;

ALTER TABLE public.advising_meeting
    ADD CONSTRAINT advising_meeting_created_by_advisor_id_fkey
        FOREIGN KEY (created_by_advisor_id) REFERENCES public.advisor (advisor_id);

COMMENT ON COLUMN public.advising_meeting.created_at IS
    'Database-authored creation timestamp (when the record was entered), never a substitute for meeting_date.';
COMMENT ON COLUMN public.advising_meeting.created_by_advisor_id IS
    'The advisor who entered the record, resolved from auth.uid() by the metadata trigger; distinct from advisor_id (who conducted the meeting). NULL for legacy and trusted technical writes.';

-- ---------------------------------------------------------------------------
-- 5. Advising application indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_advising_meeting_application
    ON public.advising_meeting (application_id);

CREATE INDEX IF NOT EXISTS idx_advising_meeting_student_application
    ON public.advising_meeting (student_id, application_id);

-- ---------------------------------------------------------------------------
-- 6. Hardened non-RPC creation-metadata trigger/function
--
-- The trigger, not the browser payload, is authoritative for creation
-- metadata (NFR1). SECURITY DEFINER runs the narrow advisor lookup as the
-- migration owner; an empty search_path plus fully qualified relations
-- prevents relation hijacking; EXECUTE is revoked from PUBLIC/anon/
-- authenticated so the function is not callable as an RPC. The trigger
-- mechanism invokes it without any EXECUTE grant; the explicit service_role
-- entry keeps the function ACL non-empty and non-default.
--
--   - authenticated browser INSERT (auth.uid() present): resolve the ACTIVE
--     advisor whose auth_user_id = auth.uid() and assign it UNCONDITIONALLY;
--     a client-supplied created_by_advisor_id/created_at is always discarded.
--     When no active advisor resolves, the attribution is NULL and the
--     existing RLS INSERT policy (is_active_advisor()) rejects the insert —
--     RLS remains the authorization gate, so an authenticated session can
--     never persist a row without correct attribution;
--   - no-auth technical INSERT (service_role/seed, auth.uid() NULL): the
--     creator is UNCONDITIONALLY NULL — a technical write is never attributed
--     to an advisor, even when the payload forges one — and the database
--     current timestamp is always stamped. This is never a browser path;
--   - UPDATE: reject any change to created_at or created_by_advisor_id. The
--     trigger is column-scoped (`UPDATE OF created_at, created_by_advisor_id`),
--     so ordinary edits to meeting fields never trip it; `advisor_id` is
--     never modified by the trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_advising_meeting_created_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_creator_advisor_id integer;
BEGIN
    -- UPDATE path: creation metadata is immutable. Any change to the creator
    -- or the database-stamped created_at is rejected fail-closed; updates that
    -- leave both unchanged (the ordinary meeting edit) pass through untouched.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.created_by_advisor_id IS DISTINCT FROM OLD.created_by_advisor_id
        THEN
            RAISE EXCEPTION
                'advising_meeting.created_at and created_by_advisor_id are database-managed creation metadata and cannot be modified';
        END IF;
        RETURN NEW;
    END IF;

    -- INSERT path. The trigger — never the payload — is authoritative for
    -- creation metadata on EVERY insert. The creator is unconditionally set
    -- to the resolved ACTIVE advisor, and NULL when no JWT/technical session
    -- is present; a client-supplied creator/time is always discarded. An
    -- authenticated session that resolves no active advisor is left with NULL
    -- attribution and is rejected by the existing RLS INSERT policy
    -- (is_active_advisor()), which remains the authorization gate.
    NEW.created_by_advisor_id := NULL;
    NEW.created_at := now();

    IF auth.uid() IS NOT NULL THEN
        SELECT a.advisor_id
          INTO v_creator_advisor_id
          FROM public.advisor a
         WHERE a.auth_user_id = auth.uid()
           AND a.is_active = true
         LIMIT 1;

        NEW.created_by_advisor_id := v_creator_advisor_id;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_advising_meeting_created_metadata()
    FROM PUBLIC, anon, authenticated;

-- The trigger mechanism invokes this function without any EXECUTE grant, so
-- nobody needs (or is given) call access. The explicit service_role entry pins
-- the ACL non-empty: a function whose ACL reverts to the default would grant
-- EXECUTE to PUBLIC, so an entry must remain. Direct invocation is harmless —
-- the function only works as a row trigger (NEW/OLD are not assigned in a
-- plain call).
GRANT EXECUTE ON FUNCTION public.set_advising_meeting_created_metadata()
    TO service_role;

DROP TRIGGER IF EXISTS trg_advising_meeting_created_metadata
    ON public.advising_meeting;

CREATE TRIGGER trg_advising_meeting_created_metadata
    BEFORE INSERT OR UPDATE OF created_at, created_by_advisor_id
    ON public.advising_meeting
    FOR EACH ROW
    EXECUTE FUNCTION public.set_advising_meeting_created_metadata();

COMMENT ON FUNCTION public.set_advising_meeting_created_metadata() IS
    'Non-RPC SECURITY DEFINER metadata trigger: on EVERY INSERT unconditionally sets created_by_advisor_id to the active advisor whose auth_user_id = auth.uid() (NULL when no JWT/technical session is present) and stamps created_at := now(), discarding any client-supplied values (RLS remains the gate for sessions without an active advisor); UPDATE changes to created_at/created_by_advisor_id are rejected. advisor_id is never modified.';