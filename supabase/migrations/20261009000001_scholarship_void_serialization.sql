-- ============================================================================
-- OCF Fellowship Management System — Scholarship terminal-Void serialization
--
-- Forward-only remediation for review finding 3 of AI-DLC change
-- 2026-10-06-historical-integrity-remediation. Migration 20261008000001
-- enforced "a Void is terminal" with a bare EXISTS check in the BEFORE INSERT
-- trigger. That check is not serializable: under READ COMMITTED two concurrent
-- amendment INSERTs for the same award can each observe "no Void yet" against
-- their own snapshot and both commit (two concurrent Voids, or a Void racing a
-- Correction destined for a voided award), defeating the invariant.
--
-- This migration closes the race at the database boundary:
--
--   1. The FIRST action of public.set_scholarship_history_amendment_metadata()
--      on INSERT is now an exclusive row lock on the parent
--      public.scholarship_history row (`SELECT ... FOR UPDATE`). Concurrent
--      amendments for the same award serialize on that lock: the loser blocks
--      until the winner commits, then re-evaluates the EXISTS guard against the
--      committed state and is rejected. The lock is held for the rest of the
--      inserting transaction, exactly like a parent-row lock in the existing
--      advisor-role / lifecycle guards.
--
--   2. A partial unique index on (history_id) WHERE amendment_type = 'Void'
--      is added as a declarative backstop for the most dangerous case (two
--      Voids). It is independent of trigger execution and cannot be bypassed by
--      ordering or a disabled trigger. The pre-flight block fails loudly if any
--      historical award already carries more than one Void, so the index is
--      never installed over already-inconsistent data (no normalization).
--
-- Nothing else changes: the amendment tables stay append-only SELECT/INSERT for
-- authenticated active advisors, the trigger remains SECURITY DEFINER with an
-- empty search_path and service_role-only EXECUTE, RLS is untouched, and the
-- effective-value views are unchanged.
-- ============================================================================


-- ============================================================================
-- 1. Pre-flight: refuse to install the single-Void backstop over inconsistent
--    history. Resolving duplicate Voids is a product/audit decision, never a
--    silent migration side effect.
-- ============================================================================
DO $$
DECLARE
    v_dup_history_id integer;
BEGIN
    SELECT a.history_id
      INTO v_dup_history_id
      FROM public.scholarship_history_amendment a
     WHERE a.amendment_type = 'Void'
     GROUP BY a.history_id
    HAVING count(*) > 1
     LIMIT 1;

    IF v_dup_history_id IS NOT NULL THEN
        RAISE EXCEPTION
            'scholarship history award % already carries multiple Void amendments; resolve before installing the single-Void unique index (no normalization performed)',
            v_dup_history_id;
    END IF;
END;
$$;


-- ============================================================================
-- 2. Declarative backstop: at most one Void per award. Partial so legitimate
--    Corrections (including several) remain unlimited and append-only.
-- ============================================================================
DROP INDEX IF EXISTS public.uidx_scholarship_history_amendment_single_void;
CREATE UNIQUE INDEX uidx_scholarship_history_amendment_single_void
    ON public.scholarship_history_amendment (history_id)
    WHERE amendment_type = 'Void';

COMMENT ON INDEX public.uidx_scholarship_history_amendment_single_void IS
    'Concurrency-safe backstop for terminal Void: at most one Void amendment per scholarship_history award.';

-- Non-unique FK/retrieval index (migration 20261008000001) already leads with
-- history_id, but it cannot enforce the single-Void invariant; the partial
-- unique index above is the declarative enforcement.


-- ============================================================================
-- 3. Revised creation-metadata trigger: lock the parent award row before the
--    terminal-Void EXISTS guard so concurrent inserts serialize. Everything
--    else (append-only UPDATE rejection, database-authored attribution, active
--    advisor resolution, EXECUTE grants) is preserved verbatim.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_scholarship_history_amendment_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_creator_advisor_id integer;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'scholarship_history_amendment records are append-only and cannot be modified';
    END IF;

    -- Serialize concurrent amendments for the SAME award on the parent
    -- scholarship_history row. Without this lock two concurrent INSERTs can each
    -- read "no Void yet" (READ COMMITTED) and both append, defeating the
    -- terminal-Void invariant. The exclusive row lock is held until the
    -- inserting transaction commits, so a competing insert blocks and then
    -- re-evaluates the EXISTS guard below against the committed state. All
    -- amendments for one award therefore apply in a single serial order.
    PERFORM 1
      FROM public.scholarship_history sh
     WHERE sh.history_id = NEW.history_id
     FOR UPDATE;

    -- The FK would reject a dangling reference anyway; fail with the FK SQLSTATE
    -- and a clear message before the terminal-Void guard or attribution lookup.
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'scholarship history award % does not exist; cannot append an amendment',
            NEW.history_id
            USING ERRCODE = '23503';
    END IF;

    -- Void amendments are terminal: a Correction may precede a Void (correct,
    -- then void), but once ANY Void exists on the award no further amendment
    -- (not even another Void) may be appended — the award stays auditable and
    -- is excluded from operational counts forever. This read is race-free only
    -- because the parent-row lock above serializes writers for this award.
    IF EXISTS (
        SELECT 1
          FROM public.scholarship_history_amendment a
         WHERE a.history_id = NEW.history_id
           AND a.amendment_type = 'Void'
    ) THEN
        RAISE EXCEPTION
            'scholarship history award % is already voided; Void is terminal and no further amendment may be appended',
            NEW.history_id
            USING ERRCODE = '42501';
    END IF;

    SELECT a.advisor_id
      INTO v_creator_advisor_id
      FROM public.advisor a
     WHERE a.auth_user_id = auth.uid()
       AND a.is_active = true
     LIMIT 1;

    IF v_creator_advisor_id IS NULL THEN
        RAISE EXCEPTION 'only an authenticated active advisor can create a scholarship history amendment'
            USING ERRCODE = '42501';
    END IF;

    NEW.created_by_advisor_id := v_creator_advisor_id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_scholarship_history_amendment_metadata()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_scholarship_history_amendment_metadata()
    TO service_role;

COMMENT ON FUNCTION public.set_scholarship_history_amendment_metadata() IS
    'Append-only metadata + terminal-Void guard for scholarship_history_amendment. SECURITY DEFINER, empty search_path. Takes an exclusive lock on the parent scholarship_history row before the Void-terminal EXISTS check so concurrent amendments for one award serialize and Void remains terminal at the database boundary.';
