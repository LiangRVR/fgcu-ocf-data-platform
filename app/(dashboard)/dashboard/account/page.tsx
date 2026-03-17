import type { Metadata } from "next";
import { AccountPage, type AccountMeetingRecord, type AdvisorStudentSummary } from "@/components/account/account-page";
import { requireAdvisor } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "My Account",
};

async function getAdvisorMeetings(advisorId: number): Promise<AccountMeetingRecord[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("advising_meeting")
    .select(
      "meeting_id, meeting_date, meeting_mode, no_show, notes, student_id, student(student_id, full_name, email, major, class_standing)"
    )
    .eq("advisor_id", advisorId)
    .order("meeting_date", { ascending: false });

  if (error || !data) {
    if (error) {
      console.error("Error loading advisor meetings:", error);
    }

    return [];
  }

  return data as AccountMeetingRecord[];
}

function buildStudentSummaries(meetings: AccountMeetingRecord[]): AdvisorStudentSummary[] {
  const byStudent = new Map<number, AdvisorStudentSummary>();

  meetings.forEach((meeting) => {
    if (!meeting.student) {
      return;
    }

    const existing = byStudent.get(meeting.student.student_id);

    if (!existing) {
      byStudent.set(meeting.student.student_id, {
        student_id: meeting.student.student_id,
        full_name: meeting.student.full_name,
        email: meeting.student.email,
        major: meeting.student.major,
        class_standing: meeting.student.class_standing,
        total_meetings: 1,
        latest_meeting_date: meeting.meeting_date,
      });
      return;
    }

    existing.total_meetings += 1;

    if (meeting.meeting_date > existing.latest_meeting_date) {
      existing.latest_meeting_date = meeting.meeting_date;
    }
  });

  return Array.from(byStudent.values()).sort((left, right) =>
    right.latest_meeting_date.localeCompare(left.latest_meeting_date)
  );
}

export default async function AccountPageRoute() {
  const advisor = await requireAdvisor();
  const meetings = await getAdvisorMeetings(advisor.advisor_id);
  const students = buildStudentSummaries(meetings);

  return (
    <AccountPage
      advisor={advisor}
      initialMeetings={meetings}
      initialStudents={students}
    />
  );
}
