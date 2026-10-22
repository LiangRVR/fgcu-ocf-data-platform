-- Advising meetings are an append-only record for authenticated staff. Keep
-- reads and creation available to active advisors, but never permit direct
-- edits or deletion through the authenticated role.

DROP POLICY IF EXISTS "active_advisor_manage_advising_meeting" ON public.advising_meeting;

CREATE POLICY "active_advisor_select_advising_meeting"
    ON public.advising_meeting
    FOR SELECT TO authenticated
    USING (public.is_active_advisor());

CREATE POLICY "active_advisor_insert_advising_meeting"
    ON public.advising_meeting
    FOR INSERT TO authenticated
    WITH CHECK (public.is_active_advisor());

REVOKE UPDATE, DELETE ON public.advising_meeting FROM authenticated;
