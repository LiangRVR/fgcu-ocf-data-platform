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

type EffectiveScholarshipHistory =
  Database["public"]["Views"]["effective_scholarship_history"]["Row"];

type ScholarshipHistory = EffectiveScholarshipHistory & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
  effective: EffectiveScholarshipHistory;
};

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type FellowshipRow = Pick<
  Database["public"]["Tables"]["fellowship"]["Row"],
  "fellowship_id" | "fellowship_name"
>;

/**
 * Scholarship History audit reader.
 *
 * Reads the shared `effective_scholarship_history` SECURITY INVOKER view so the
 * corrected award program is displayed (never the immutable base value) and the
 * authoritative `is_voided` state is available for the audit surface. This page
 * deliberately retains voided awards so their audit trail stays visible; the
 * operational counts derived from this list exclude them (see
 * `summarizeOperationalAwards`).
 *
 * The view carries no PostgREST relationship to `student`/`fellowship`, so the
 * display names are resolved with scoped lookups rather than embedded joins.
 */
export async function getScholarshipHistory(): Promise<ScholarshipHistory[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("effective_scholarship_history")
      .select("*")
      .order("history_id", { ascending: false });
    if (error) {
      console.error("Error fetching scholarship history:", error);
      return [];
    }

    const records = (data as EffectiveScholarshipHistory[]) || [];

    const studentIds = [...new Set(records.map((record) => record.student_id))];
    const nameById = new Map<number, string>();
    if (studentIds.length > 0) {
      const { data: students } = await supabase
        .from("student")
        .select("student_id, full_name")
        .in("student_id", studentIds);
      for (const student of students ?? []) {
        nameById.set(student.student_id, student.full_name);
      }
    }

    // Corrected award assignment: the effective `fellowship_id` is what the
    // operational view must present, never the immutable base value.
    const fellowshipIds = [...new Set(records.map((record) => record.fellowship_id))];
    const fellowshipNameById = new Map<number, string>();
    if (fellowshipIds.length > 0) {
      const { data: fellowships } = await supabase
        .from("fellowship")
        .select("fellowship_id, fellowship_name")
        .in("fellowship_id", fellowshipIds);
      for (const fellowship of fellowships ?? []) {
        fellowshipNameById.set(fellowship.fellowship_id, fellowship.fellowship_name);
      }
    }

    return records.map((record) => ({
      ...record,
      effective: record,
      student: nameById.has(record.student_id)
        ? { full_name: nameById.get(record.student_id)! }
        : null,
      fellowship: fellowshipNameById.has(record.fellowship_id)
        ? { fellowship_name: fellowshipNameById.get(record.fellowship_id)! }
        : null,
    }));
  } catch {
    return [];
  }
}

/**
 * Active-students selector for the scholarship-history form. Excludes
 * archived students server-side.
 */
async function getActiveStudents(): Promise<StudentRow[]> {
  const supabase = createServerClient();
  try {
    let query = supabase
      .from("student")
      .select("student_id, full_name");
    if (typeof (query as { is?: unknown }).is === "function") {
      query = (query as unknown as { is: (col: string, val: null) => typeof query }).is(
        "archived_at",
        null,
      );
    }
    const { data } = await query.order("full_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Active-fellowships selector for the scholarship-history form. Excludes
 * archived fellowships server-side.
 */
async function getActiveFellowships(): Promise<FellowshipRow[]> {
  const supabase = createServerClient();
  try {
    let query = supabase
      .from("fellowship")
      .select("fellowship_id, fellowship_name");
    if (typeof (query as { is?: unknown }).is === "function") {
      query = (query as unknown as { is: (col: string, val: null) => typeof query }).is(
        "archived_at",
        null,
      );
    }
    const { data } = await query.order("fellowship_name", { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Operational award summary for the Scholarship History counts. Voided awards
 * stay on the audit surface (and remain listed) but are excluded from the
 * operational totals, so a void never inflates the recorded-award counts.
 */
export function summarizeOperationalAwards(records: ScholarshipHistory[]): {
  records: number;
  students: number;
  repeatAwards: number;
} {
  const operational = records.filter((record) => !record.is_voided);
  const students = new Set(operational.map((record) => record.student_id)).size;
  return {
    records: operational.length,
    students,
    repeatAwards: operational.length - students,
  };
}

export default async function ScholarshipHistoryPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const defaultFellowshipId = params.fellowship_id;

  const [records, students, fellowships] = await Promise.all([
    getScholarshipHistory(),
    getActiveStudents(),
    getActiveFellowships(),
  ]);
  const { records: awardCount, students: uniqueStudents, repeatAwards } =
    summarizeOperationalAwards(records);

  return (
    <>
      <PageHeader
        eyebrow="Award History"
        title="Scholarship History"
        description="Record prior awards and preserve historical context for students with new fellowship activity."
      >
        <MetricBadge tone="blue">{awardCount} records</MetricBadge>
        <MetricBadge tone="green">{uniqueStudents} students</MetricBadge>
        <MetricBadge tone="amber">{fellowships.length} fellowships</MetricBadge>
      </PageHeader>

      <PageSection
        title="Historical Coverage"
        description="Preserve award history as advising context and track how widely prior fellowship outcomes are represented across students and programs."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={BookOpen} value={awardCount} title="Award Records" description="Historical award outcomes on file" tone="blue" />
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
