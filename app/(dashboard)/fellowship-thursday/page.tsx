import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { FellowshipThursdayTable } from "@/components/fellowship-thursday/fellowship-thursday-table";
import type { Database } from "@/types/database";
import { CalendarDays, CircleCheckBig, Tags, Users } from "lucide-react";

export const metadata: Metadata = { title: "Fellowship Thursday" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
  }>;
}

type FellowshipThursday =
  Database["public"]["Tables"]["fellowship_thursday"]["Row"] & {
    student: { full_name: string } | null;
  };

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

async function getFellowshipThursdayRecords(): Promise<FellowshipThursday[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("fellowship_thursday")
      .select(`*, student(full_name)`)
      .order("attendance_id", { ascending: false });
    if (error) {
      console.error("Error fetching fellowship thursday records:", error);
      return [];
    }
    return (data as FellowshipThursday[]) || [];
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

export default async function FellowshipThursdayPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;

  const [records, students] = await Promise.all([
    getFellowshipThursdayRecords(),
    getStudents(),
  ]);
  const attendedCount = records.filter((record) => record.attended).length;
  const sourcedCount = records.filter((record) => Boolean(record.source_info)).length;
  const uniqueStudents = new Set(records.map((record) => record.student_id)).size;
  const missedCount = records.length - attendedCount;

  return (
    <>
      <PageHeader
        eyebrow="Event Outreach"
        title="Fellowship Thursday"
        description="Track weekly Fellowship Thursday attendance and monitor which students are entering through partner channels."
      >
        <MetricBadge tone="blue">{records.length} records</MetricBadge>
        <MetricBadge tone="green">{attendedCount} attended</MetricBadge>
        <MetricBadge tone="amber">{sourcedCount} tagged sources</MetricBadge>
      </PageHeader>

      <PageSection
        title="Attendance Snapshot"
        description="Review participation, source attribution, and how broadly Fellowship Thursday is reaching the student population."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={CalendarDays} value={records.length} title="Attendance Records" description="All Fellowship Thursday records currently tracked" tone="blue" />
          <StatCard icon={CircleCheckBig} value={attendedCount} title="Attended" description="Students marked as present at the event" tone="green" />
          <StatCard icon={Users} value={uniqueStudents} title="Students Reached" description={`${missedCount} absence record${missedCount === 1 ? "" : "s"} captured`} tone="violet" />
          <StatCard icon={Tags} value={sourcedCount} title="Tagged Sources" description="Records with outreach-source attribution" tone="amber" />
        </div>
      </PageSection>

      <FellowshipThursdayTable
        initialRecords={records}
        students={students}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
      />
    </>
  );
}
