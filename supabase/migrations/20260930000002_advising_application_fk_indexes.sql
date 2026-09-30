-- Cover the new advising_meeting foreign keys added by the advising/application
-- link migration. Keep the existing (student_id, application_id) index for
-- student-scoped advising queries; these indexes cover FK delete/update checks.

CREATE INDEX IF NOT EXISTS idx_advising_meeting_application_student
    ON public.advising_meeting (application_id, student_id);

CREATE INDEX IF NOT EXISTS idx_advising_meeting_created_by_advisor
    ON public.advising_meeting (created_by_advisor_id);
