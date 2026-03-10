import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { createServerClient } from "@/lib/supabase/server";
import { AdvisingTable } from "@/components/advising/advising-table";
import type { Database } from "@/types/database";
import Link from "next/link";

export const metadata: Metadata = { title: "Advising" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    advisor_id?: string;
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
  const autoOpenAdd       = params.add     === "1";
  const defaultStudentId  = params.student_id;
  const defaultAdvisorId  = params.advisor_id;
  const initialNoShowFilter = params.no_show === "yes" ? "yes" : undefined;

  const [meetings, students, advisors] = await Promise.all([
    getAdvisingMeetings(),
    getStudents(),
    getAdvisors(),
  ]);

  // Compute exception counts for pill bar labels
  const noShowCount = meetings.filter((m) => m.no_show).length;
  const studentIdsWithMeetings = new Set(meetings.map((m) => m.student_id));
  const neverSeenCount = students.filter((s) => !studentIdsWithMeetings.has(s.student_id)).length;

  const isNoShow = params.no_show === "yes";

  return (
    <>
      <PageHeader
        title="Advising"
        description="Track and manage advising sessions between students and advisors"
      />

      {/* Exception view pill bar */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Link
          href="/advising"
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            !isNoShow
              ? "bg-slate-900 text-white border-slate-900"
              : "border-gray-200 bg-white text-slate-600 hover:border-slate-400"
          }`}
        >
          All Meetings
        </Link>
        <Link
          href="/advising?no_show=yes"
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            isNoShow
              ? "bg-red-600 text-white border-red-600"
              : "border-red-200 bg-red-50 text-red-700 hover:border-red-400"
          }`}
        >
          No-Shows
          {!isNoShow && noShowCount > 0 && (
            <span className="ml-1.5 tabular-nums">({noShowCount})</span>
          )}
        </Link>
        <Link
          href="/students?view=no-advising"
          className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 transition-colors hover:border-amber-400"
        >
          Students Never Seen
          {neverSeenCount > 0 && (
            <span className="ml-1.5 tabular-nums">({neverSeenCount})</span>
          )}
        </Link>
      </div>

      {isNoShow && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Showing only meetings where the student did not attend.
          <Link href="/advising" className="ml-2 underline hover:text-red-600">Clear filter</Link>
        </div>
      )}

      <AdvisingTable
        initialMeetings={meetings}
        students={students}
        advisors={advisors}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultAdvisorId={defaultAdvisorId}
        initialNoShowFilter={initialNoShowFilter}
      />
    </>
  );
}
