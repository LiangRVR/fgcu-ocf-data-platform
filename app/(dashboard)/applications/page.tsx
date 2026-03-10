import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { createServerClient } from "@/lib/supabase/server";
import { ApplicationsTable } from "@/components/applications/applications-table";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Applications" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    fellowship_id?: string;
    stage?: string;
    fellowship?: string;
  }>;
}

type Application = Database["public"]["Tables"]["application"]["Row"] & {
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

async function getApplications(): Promise<Application[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("application")
      .select(`*, student(full_name), fellowship(fellowship_name)`)
      .order("application_id", { ascending: false });

    if (error) {
      console.error("Error fetching applications:", error);
      return [];
    }
    return (data as Application[]) || [];
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

export default async function ApplicationsPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const defaultFellowshipId = params.fellowship_id;
  const initialStageFilter = params.stage;
  const initialSearchQuery = params.fellowship;

  const [applications, students, fellowships] = await Promise.all([
    getApplications(),
    getStudents(),
    getFellowships(),
  ]);

  return (
    <>
      <PageHeader
        title="Applications"
        description="Track student fellowship applications and statuses"
      />

      <ApplicationsTable
        initialApplications={applications}
        students={students}
        fellowships={fellowships}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultFellowshipId={defaultFellowshipId}
        initialStageFilter={initialStageFilter}
        initialSearchQuery={initialSearchQuery}
      />
    </>
  );
}
