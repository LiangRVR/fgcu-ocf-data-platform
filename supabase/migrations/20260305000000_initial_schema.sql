-- ============================================================================
-- OCF Fellowship Management System — Initial Schema
-- FGCU Office of Competitive Fellowships
--
-- This migration creates the canonical database schema.
-- All table names are SINGULAR. All primary keys are INTEGER SEQUENCES.
-- Do NOT use UUID primary keys or plural table names in this project.
--
-- Table creation order respects foreign key dependencies:
--   1. advisor       (no FKs)
--   2. fellowship    (no FKs)
--   3. student       (no FKs)
--   4. application           → student, fellowship
--   5. advising_meeting      → student, advisor
--   6. fellowship_thursday   → student
--   7. scholarship_history   → student, fellowship
-- ============================================================================


-- ============================================================================
-- advisor
--
-- Holds the list of OCF advisors who conduct advising meetings.
-- advisor_name is unique so the same person cannot be entered twice.
-- ============================================================================
CREATE TABLE public.advisor (
    advisor_id  integer    NOT NULL DEFAULT nextval('advisor_advisor_id_seq'::regclass),
    advisor_name character varying NOT NULL,
    CONSTRAINT advisor_pkey PRIMARY KEY (advisor_id),
    CONSTRAINT advisor_advisor_name_key UNIQUE (advisor_name)
);

-- Sequence that backs advisor_id
CREATE SEQUENCE IF NOT EXISTS public.advisor_advisor_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.advisor_advisor_id_seq OWNED BY public.advisor.advisor_id;


-- ============================================================================
-- fellowship
--
-- Holds each fellowship or scholarship program that the OCF tracks.
-- fellowship_name is unique to prevent duplicate program entries.
-- ============================================================================
CREATE TABLE public.fellowship (
    fellowship_id   integer          NOT NULL DEFAULT nextval('fellowship_fellowship_id_seq'::regclass),
    fellowship_name character varying NOT NULL,
    CONSTRAINT fellowship_pkey PRIMARY KEY (fellowship_id),
    CONSTRAINT fellowship_fellowship_name_key UNIQUE (fellowship_name)
);

CREATE SEQUENCE IF NOT EXISTS public.fellowship_fellowship_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.fellowship_fellowship_id_seq OWNED BY public.fellowship.fellowship_id;


-- ============================================================================
-- student
--
-- Core profile table for every FGCU student tracked by the OCF.
--
-- Notable constraints:
--   gpa            — must be between 0.00 and 4.00 (U.S. scale)
--   class_standing — controlled vocabulary; prevents free-form text errors
--   gender         — short codes: F, M, NB (non-binary), NR (not reported)
--   us_citizen     — required for most fellowship eligibility checks
-- ============================================================================
CREATE TABLE public.student (
    student_id     integer          NOT NULL DEFAULT nextval('student_student_id_seq'::regclass),
    full_name      character varying NOT NULL,
    is_ch_student  boolean          NOT NULL DEFAULT false,
    email          character varying NOT NULL,
    major          character varying,
    minor          character varying,
    gpa            numeric,
    class_standing character varying,
    us_citizen     boolean          NOT NULL,
    age            integer,
    gender         character varying,
    pronouns       character varying,
    race_ethnicity character varying,
    languages      character varying,
    first_gen      boolean          NOT NULL DEFAULT false,
    honors_college boolean          NOT NULL DEFAULT false,
    CONSTRAINT student_pkey PRIMARY KEY (student_id),
    -- GPA must be a valid U.S. 4.0-scale value
    CONSTRAINT student_gpa_check CHECK (
        gpa IS NULL OR (gpa >= 0.00 AND gpa <= 4.00)
    ),
    -- Restrict class_standing to known enrollment levels
    CONSTRAINT student_class_standing_check CHECK (
        class_standing IS NULL OR class_standing::text = ANY (ARRAY[
            'Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate', 'Doctoral'
        ])
    ),
    -- Gender is stored as a short code to avoid inconsistent free-form entries
    CONSTRAINT student_gender_check CHECK (
        gender IS NULL OR gender::text = ANY (ARRAY['F', 'M', 'NB', 'NR'])
    )
);

CREATE SEQUENCE IF NOT EXISTS public.student_student_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.student_student_id_seq OWNED BY public.student.student_id;

-- Indexes on commonly filtered and looked-up columns
CREATE INDEX idx_student_email         ON public.student (email);
CREATE INDEX idx_student_is_ch         ON public.student (is_ch_student);
CREATE INDEX idx_student_class_standing ON public.student (class_standing);


-- ============================================================================
-- application
--
-- Records a student's application to one fellowship program.
-- One student may have multiple rows for the same fellowship (e.g., across
-- different years), so there is intentionally NO unique constraint on
-- (student_id, fellowship_id).
--
-- stage_of_application — controlled vocabulary representing the pipeline
--   position of the application.  The values are ordered roughly by
--   progression: Started → Submitted → Under Review → Semi-Finalist →
--   Finalist → Awarded / Rejected.
--
-- is_semi_finalist / is_finalist — denormalised boolean flags that duplicate
--   information already implied by stage_of_application.  They exist for fast
--   filtering (e.g. "show me all finalists") without a string comparison.
-- ============================================================================
CREATE TABLE public.application (
    application_id       integer          NOT NULL DEFAULT nextval('application_application_id_seq'::regclass),
    student_id           integer          NOT NULL,
    fellowship_id        integer          NOT NULL,
    destination_country  character varying,
    stage_of_application character varying NOT NULL,
    is_semi_finalist     boolean          NOT NULL DEFAULT false,
    is_finalist          boolean          NOT NULL DEFAULT false,
    CONSTRAINT application_pkey PRIMARY KEY (application_id),
    CONSTRAINT application_student_id_fkey
        FOREIGN KEY (student_id) REFERENCES public.student (student_id),
    CONSTRAINT application_fellowship_id_fkey
        FOREIGN KEY (fellowship_id) REFERENCES public.fellowship (fellowship_id),
    -- Restrict stage values to the known OCF pipeline stages
    CONSTRAINT application_stage_check CHECK (
        stage_of_application::text = ANY (ARRAY[
            'Started', 'Submitted', 'Under Review',
            'Semi-Finalist', 'Finalist', 'Awarded', 'Rejected'
        ])
    )
);

CREATE SEQUENCE IF NOT EXISTS public.application_application_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.application_application_id_seq OWNED BY public.application.application_id;

CREATE INDEX idx_application_student   ON public.application (student_id);
CREATE INDEX idx_application_fellowship ON public.application (fellowship_id);
CREATE INDEX idx_application_stage     ON public.application (stage_of_application);


-- ============================================================================
-- advising_meeting
--
-- Records each advising session between a student and an OCF advisor.
--
-- advisor_id is nullable: a meeting can be logged before an advisor is assigned.
-- meeting_mode — must be 'In-Person' or 'Virtual'; no other delivery modes exist.
-- no_show      — true when the student failed to attend the scheduled meeting.
-- ============================================================================
CREATE TABLE public.advising_meeting (
    meeting_id   integer          NOT NULL DEFAULT nextval('advising_meeting_meeting_id_seq'::regclass),
    student_id   integer          NOT NULL,
    advisor_id   integer,
    meeting_date date             NOT NULL,
    meeting_mode character varying NOT NULL,
    no_show      boolean          NOT NULL DEFAULT false,
    notes        text,
    CONSTRAINT advising_meeting_pkey PRIMARY KEY (meeting_id),
    CONSTRAINT advising_meeting_student_id_fkey
        FOREIGN KEY (student_id) REFERENCES public.student (student_id),
    CONSTRAINT advising_meeting_advisor_id_fkey
        FOREIGN KEY (advisor_id) REFERENCES public.advisor (advisor_id),
    -- Only two delivery modes are recognised
    CONSTRAINT advising_meeting_mode_check CHECK (
        meeting_mode::text = ANY (ARRAY['In-Person', 'Virtual'])
    )
);

CREATE SEQUENCE IF NOT EXISTS public.advising_meeting_meeting_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.advising_meeting_meeting_id_seq OWNED BY public.advising_meeting.meeting_id;

CREATE INDEX idx_advising_meeting_student ON public.advising_meeting (student_id);
CREATE INDEX idx_advising_meeting_date    ON public.advising_meeting (meeting_date);


-- ============================================================================
-- fellowship_thursday
--
-- Tracks whether a student attended the weekly Thursday fellowship meeting.
--
-- source_info — indicates which OCF programme introduced the student to the
--   Thursday meeting.  NULL means the source was not recorded.
--   Allowed values:
--     OCF = Office of Competitive Fellowships (direct referral)
--     HC  = Honors College
--     MM  = McNair Scholars / Miami Mosaic (or other named programme)
-- ============================================================================
CREATE TABLE public.fellowship_thursday (
    attendance_id integer          NOT NULL DEFAULT nextval('fellowship_thursday_attendance_id_seq'::regclass),
    student_id    integer          NOT NULL,
    attended      boolean          NOT NULL,
    source_info   character varying,
    CONSTRAINT fellowship_thursday_pkey PRIMARY KEY (attendance_id),
    CONSTRAINT fellowship_thursday_student_id_fkey
        FOREIGN KEY (student_id) REFERENCES public.student (student_id),
    -- source_info is optional, but when present must be a known code
    CONSTRAINT fellowship_thursday_source_check CHECK (
        source_info IS NULL OR source_info::text = ANY (ARRAY['OCF', 'HC', 'MM'])
    )
);

CREATE SEQUENCE IF NOT EXISTS public.fellowship_thursday_attendance_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.fellowship_thursday_attendance_id_seq OWNED BY public.fellowship_thursday.attendance_id;

CREATE INDEX idx_fellowship_thursday_student ON public.fellowship_thursday (student_id);


-- ============================================================================
-- scholarship_history
--
-- Records fellowships that a student has previously been awarded.
-- Distinct from application: this table only holds confirmed awards,
-- not in-progress applications.
-- ============================================================================
CREATE TABLE public.scholarship_history (
    history_id    integer NOT NULL DEFAULT nextval('scholarship_history_history_id_seq'::regclass),
    student_id    integer NOT NULL,
    fellowship_id integer NOT NULL,
    CONSTRAINT scholarship_history_pkey PRIMARY KEY (history_id),
    CONSTRAINT scholarship_history_student_id_fkey
        FOREIGN KEY (student_id) REFERENCES public.student (student_id),
    CONSTRAINT scholarship_history_fellowship_id_fkey
        FOREIGN KEY (fellowship_id) REFERENCES public.fellowship (fellowship_id)
);

CREATE SEQUENCE IF NOT EXISTS public.scholarship_history_history_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.scholarship_history_history_id_seq OWNED BY public.scholarship_history.history_id;

CREATE INDEX idx_scholarship_history_student   ON public.scholarship_history (student_id);
CREATE INDEX idx_scholarship_history_fellowship ON public.scholarship_history (fellowship_id);


-- ============================================================================
-- Row Level Security
--
-- RLS is enabled on every table.  Permissive read policies for the anon role
-- are applied in the next migration (20260305000001_allow_anon_read.sql).
-- Write access requires authentication and should be configured per deployment.
-- ============================================================================
ALTER TABLE public.advisor             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fellowship          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.application         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.advising_meeting    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fellowship_thursday ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scholarship_history ENABLE ROW LEVEL SECURITY;
