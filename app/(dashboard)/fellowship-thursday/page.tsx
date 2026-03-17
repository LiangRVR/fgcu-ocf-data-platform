import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { createServerClient } from "@/lib/supabase/server";
import { FellowshipThursdayTable } from "@/components/fellowship-thursday/fellowship-thursday-table";
import type { Database } from "@/types/database";

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
      <FellowshipThursdayTable
        initialRecords={records}
        students={students}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
      />
    </>
  );
}
