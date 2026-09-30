-- Append-only corrections to historic advising meetings. This is deliberately
-- a separate record: it never changes advising_meeting or its RLS policies.
-- `reason` and `details` are trim-aware nonempty (Oracle finding 1); the
-- retrieval index leads with meeting_id and orders by created_at then
-- amendment_id for chronological per-meeting reads (Oracle finding 2).

CREATE SEQUENCE public.advising_meeting_amendment_amendment_id_seq;

CREATE TABLE public.advising_meeting_amendment (
    amendment_id integer NOT NULL DEFAULT nextval('public.advising_meeting_amendment_amendment_id_seq'::regclass) PRIMARY KEY,
    meeting_id integer NOT NULL REFERENCES public.advising_meeting (meeting_id),
    created_by_advisor_id integer NOT NULL REFERENCES public.advisor (advisor_id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Trim set: space, tab, newline, carriage return, form feed, and vertical
    -- tab. Vertical tab is expressed as the hex escape \x0b — PostgreSQL has
    -- no \v escape, so a literal 'v' must never be part of the trim set.
    reason text NOT NULL
        CONSTRAINT advising_meeting_amendment_reason_not_blank CHECK (btrim(reason, E' \t\n\r\f\x0b') <> ''),
    details text NOT NULL
        CONSTRAINT advising_meeting_amendment_details_not_blank CHECK (btrim(details, E' \t\n\r\f\x0b') <> '')
);

ALTER SEQUENCE public.advising_meeting_amendment_amendment_id_seq
    OWNED BY public.advising_meeting_amendment.amendment_id;

COMMENT ON TABLE public.advising_meeting_amendment IS
    'Append-only correction records for advising meetings; corrections never alter the original meeting.';
COMMENT ON COLUMN public.advising_meeting_amendment.created_by_advisor_id IS
    'Database-resolved active advisor who recorded the amendment; client values are ignored.';
COMMENT ON COLUMN public.advising_meeting_amendment.created_at IS
    'Database-authored amendment entry timestamp; client values are ignored.';
COMMENT ON COLUMN public.advising_meeting_amendment.reason IS
    'Short explanation of why the correction is needed; must be non-empty after trimming whitespace (CHECK).';
COMMENT ON COLUMN public.advising_meeting_amendment.details IS
    'Correction details; must be non-empty after trimming whitespace (CHECK).';

-- Retrieval index for the per-meeting amendment history: the leading
-- meeting_id covers FK lookups while created_at/amendment_id order each
-- meeting's correction chain chronologically.
DROP INDEX IF EXISTS public.idx_advising_meeting_amendment_meeting;
CREATE INDEX idx_advising_meeting_amendment_meeting
    ON public.advising_meeting_amendment (meeting_id, created_at, amendment_id);
CREATE INDEX idx_advising_meeting_amendment_created_by_advisor
    ON public.advising_meeting_amendment (created_by_advisor_id);

ALTER TABLE public.advising_meeting_amendment ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.set_advising_meeting_amendment_created_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_creator_advisor_id integer;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'advising_meeting_amendment records are append-only and cannot be modified';
    END IF;

    SELECT a.advisor_id
      INTO v_creator_advisor_id
      FROM public.advisor a
     WHERE a.auth_user_id = auth.uid()
       AND a.is_active = true
     LIMIT 1;

    IF v_creator_advisor_id IS NULL THEN
        RAISE EXCEPTION 'only an authenticated active advisor can create an advising meeting amendment'
            USING ERRCODE = '42501';
    END IF;

    NEW.created_by_advisor_id := v_creator_advisor_id;
    NEW.created_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_advising_meeting_amendment_created_metadata()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_advising_meeting_amendment_created_metadata()
    TO service_role;

CREATE TRIGGER trg_advising_meeting_amendment_created_metadata
    BEFORE INSERT OR UPDATE ON public.advising_meeting_amendment
    FOR EACH ROW
    EXECUTE FUNCTION public.set_advising_meeting_amendment_created_metadata();

CREATE POLICY "active_advisor_select_advising_meeting_amendment"
    ON public.advising_meeting_amendment
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_advising_meeting_amendment"
    ON public.advising_meeting_amendment
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

REVOKE ALL ON public.advising_meeting_amendment FROM anon;
GRANT SELECT, INSERT ON public.advising_meeting_amendment TO authenticated;
REVOKE UPDATE, DELETE ON public.advising_meeting_amendment FROM authenticated;
-- The local Supabase image installs default privileges that would hand the
-- new sequence to anon/authenticated; revoke the anon (and PUBLIC) grants so
-- the append-only table's backing sequence follows the ...004 steady state.
REVOKE ALL ON SEQUENCE public.advising_meeting_amendment_amendment_id_seq
    FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.advising_meeting_amendment_amendment_id_seq TO authenticated;
