import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { createServerClient } from "@/lib/supabase/server";
import { AdvisingTable } from "@/components/advising/advising-table";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Advising" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    no_show?: string;
  }>;
}

type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { full_name: string } | null;
  advisor: { advisor_name: string } | null;
};

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type AdvisorRow = Pick<
  Database["public"]["Tables"]["advisor"]["Row"],
  "advisor_id" | "advisor_name"
>;

async function getAdvisingMeetings(): Promise<AdvisingMeeting[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("advising_meeting")
      .select(`*, student(full_name), advisor(advisor_name)`)
      .order("meeting_date", { ascending: false });
    if (error) {
      console.error("Error fetching advising meetings:", error);
      return [];
    }
    return (data as AdvisingMeeting[]) || [];
  } catch {
    return [];
  }
}

async function getStudents(): Promise<StudentRow[]> {
  const supabase = createServerClient();
  try {
    const { data } = await supabase
      .from("student")
      .select("student_id, full_name")
      .order("full_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

async function getAdvisors(): Promise<AdvisorRow[]> {
  const supabase = createServerClient();
  try {
    const { data } = await supabase
      .from("advisor")
      .select("advisor_id, advisor_name")
      .order("advisor_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

export default async function AdvisingPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const initialNoShowFilter = params.no_show === "yes" ? "yes" : undefined;

  const [meetings, students, advisors] = await Promise.all([
    getAdvisingMeetings(),
    getStudents(),
    getAdvisors(),
  ]);

  return (
    <>
      <PageHeader
        title="Advising"
        description="Track and manage advising sessions between students and advisors"
      />
      <AdvisingTable
        initialMeetings={meetings}
        students={students}
        advisors={advisors}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        initialNoShowFilter={initialNoShowFilter}
      />
    </>
  );
}
