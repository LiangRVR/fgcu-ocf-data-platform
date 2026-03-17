import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { ScholarshipHistoryTable } from "@/components/scholarship-history/scholarship-history-table";
import type { Database } from "@/types/database";
import { Award, BookOpen, Trophy, Users } from "lucide-react";

export const metadata: Metadata = { title: "Scholarship History" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    fellowship_id?: string;
  }>;
}

type ScholarshipHistory =
  Database["public"]["Tables"]["scholarship_history"]["Row"] & {
    student: { full_name: string } | null;
    fellowship: { fellowship_name: string } | null;
  };

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type FellowshipRow = Pick<
  Database["public"]["Tables"]["fellowship"]["Row"],
  "fellowship_id" | "fellowship_name"
>;

async function getScholarshipHistory(): Promise<ScholarshipHistory[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("scholarship_history")
      .select(`*, student(full_name), fellowship(fellowship_name)`)
      .order("history_id", { ascending: false });
    if (error) {
      console.error("Error fetching scholarship history:", error);
      return [];
    }
    return (data as ScholarshipHistory[]) || [];
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

async function getFellowships(): Promise<FellowshipRow[]> {
  const supabase = createServerClient();
  try {
    const { data } = await supabase
      .from("fellowship")
      .select("fellowship_id, fellowship_name")
      .order("fellowship_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

export default async function ScholarshipHistoryPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const defaultFellowshipId = params.fellowship_id;

  const [records, students, fellowships] = await Promise.all([
    getScholarshipHistory(),
    getStudents(),
    getFellowships(),
  ]);
  const uniqueStudents = new Set(records.map((record) => record.student_id)).size;
  const repeatAwards = records.length - uniqueStudents;

  return (
    <>
      <PageHeader
        eyebrow="Award History"
        title="Scholarship History"
        description="Record prior awards and preserve historical context for students with new fellowship activity."
      >
        <MetricBadge tone="blue">{records.length} records</MetricBadge>
        <MetricBadge tone="green">{uniqueStudents} students</MetricBadge>
        <MetricBadge tone="amber">{fellowships.length} fellowships</MetricBadge>
      </PageHeader>

      <PageSection
        title="Historical Coverage"
        description="Preserve award history as advising context and track how widely prior fellowship outcomes are represented across students and programs."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={BookOpen} value={records.length} title="Award Records" description="Historical award outcomes on file" tone="blue" />
          <StatCard icon={Users} value={uniqueStudents} title="Students With History" description="Students connected to prior awards" tone="green" />
          <StatCard icon={Award} value={fellowships.length} title="Tracked Fellowships" description="Programs represented in historical records" tone="amber" />
          <StatCard icon={Trophy} value={repeatAwards} title="Repeat Awards" description="Additional awards beyond each student's first recorded history item" tone="violet" />
        </div>
      </PageSection>

      <ScholarshipHistoryTable
        initialRecords={records}
        students={students}
        fellowships={fellowships}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultFellowshipId={defaultFellowshipId}
      />
    </>
  );
}
