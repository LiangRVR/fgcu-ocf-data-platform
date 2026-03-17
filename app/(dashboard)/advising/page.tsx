import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { requireAdvisor } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { AdvisingTable } from "@/components/advising/advising-table";
import type { Database } from "@/types/database";
import Link from "next/link";
import { CalendarCheck2, ShieldAlert, UserRoundCheck, Users } from "lucide-react";

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
      .eq("is_active", true)
      .order("advisor_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

export default async function AdvisingPage({ searchParams }: Props) {
  const advisor = await requireAdvisor();
  const params = await searchParams;
  const autoOpenAdd       = params.add     === "1";
  const defaultStudentId  = params.student_id;
  const defaultAdvisorId  = params.advisor_id ?? String(advisor.advisor_id);
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
  const advisorCoverage = new Set(meetings.map((m) => m.advisor_id).filter((advisorId): advisorId is number => advisorId !== null)).size;

  const isNoShow = params.no_show === "yes";

  return (
    <>
      <PageHeader
        eyebrow="Advisor Activity"
        title="Advising"
        description="Track advising sessions, attendance risk, and students who still need advisor contact."
      >
        <MetricBadge tone="blue">{meetings.length} meetings</MetricBadge>
        <MetricBadge tone="red">{noShowCount} no-shows</MetricBadge>
        <MetricBadge tone="amber">{neverSeenCount} never seen</MetricBadge>
      </PageHeader>

      <PageSection
        title="Advising Coverage"
        description="Use these metrics to identify attendance risk, advisor load, and which students still need first contact."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={CalendarCheck2} value={meetings.length} title="Meetings Logged" description="Advising sessions currently on record" tone="blue" />
          <StatCard icon={ShieldAlert} value={noShowCount} title="No-Shows" description="Meetings where the student did not attend" tone="rose" />
          <StatCard icon={Users} value={neverSeenCount} title="Students Never Seen" description="Students with no advising history yet" tone="amber" />
          <StatCard icon={UserRoundCheck} value={advisorCoverage} title="Active Advisors" description="Advisors represented in recorded meetings" tone="green" />
        </div>
      </PageSection>

      {/* Exception view pill bar */}
      <div className="mb-8 flex flex-wrap gap-2">
        <Link
          href="/advising"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            !isNoShow
              ? "border-slate-900 bg-slate-900 text-white shadow-sm"
              : "border-border bg-white/80 text-slate-600 hover:border-slate-400 hover:bg-white"
          }`}
        >
          All Meetings
        </Link>
        <Link
          href="/advising?no_show=yes"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
            isNoShow
              ? "border-red-600 bg-red-600 text-white shadow-sm"
              : "border-red-200 bg-red-50/80 text-red-700 hover:border-red-400 hover:bg-red-50"
          }`}
        >
          No-Shows
          {!isNoShow && noShowCount > 0 && (
            <span className="ml-1.5 tabular-nums">({noShowCount})</span>
          )}
        </Link>
        <Link
          href="/students?view=no-advising"
          className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50/80 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:border-amber-400 hover:bg-amber-50"
        >
          Students Never Seen
          {neverSeenCount > 0 && (
            <span className="ml-1.5 tabular-nums">({neverSeenCount})</span>
          )}
        </Link>
      </div>

      {isNoShow && (
        <AppCard variant="soft" className="mb-6 border-red-200/70 bg-red-50/70">
          <AppCardContent className="flex flex-col gap-2 p-4 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between">
            <p>Showing only meetings where the student did not attend.</p>
            <Link href="/advising" className="font-medium underline underline-offset-4 hover:text-red-600">Clear filter</Link>
          </AppCardContent>
        </AppCard>
      )}

      <AdvisingTable
        initialMeetings={meetings}
        students={students}
        advisors={advisors}
        currentAdvisorId={advisor.advisor_id}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultAdvisorId={defaultAdvisorId}
        initialNoShowFilter={initialNoShowFilter}
      />
    </>
  );
}
