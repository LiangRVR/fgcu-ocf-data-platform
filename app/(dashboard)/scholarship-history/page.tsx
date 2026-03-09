import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { createServerClient } from "@/lib/supabase/server";
import { ScholarshipHistoryTable } from "@/components/scholarship-history/scholarship-history-table";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Scholarship History" };

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

export default async function ScholarshipHistoryPage() {
  const [records, students, fellowships] = await Promise.all([
    getScholarshipHistory(),
    getStudents(),
    getFellowships(),
  ]);

  return (
    <>
      <PageHeader
        title="Scholarship History"
        description="Prior scholarship and fellowship awards received by students"
      />
      <ScholarshipHistoryTable
        initialRecords={records}
        students={students}
        fellowships={fellowships}
      />
    </>
  );
}
