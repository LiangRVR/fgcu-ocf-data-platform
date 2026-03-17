import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { ApplicationsTable } from "@/components/applications/applications-table";
import type { Database } from "@/types/database";
import { Award, FileText, Trophy, Users } from "lucide-react";

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
  const finalistCount = applications.filter((application) => application.is_finalist).length;
  const awardedCount = applications.filter((application) => application.stage_of_application === "Awarded").length;
  const uniqueStudents = new Set(applications.map((application) => application.student_id)).size;
  const uniqueFellowships = new Set(applications.map((application) => application.fellowship_id)).size;

  return (
    <>
      <PageHeader
        eyebrow="Application Pipeline"
        title="Applications"
        description="Track fellowship applications from first draft through finalist and award decisions."
      >
        <MetricBadge tone="blue">{applications.length} total</MetricBadge>
        <MetricBadge tone="green">{finalistCount} finalists</MetricBadge>
        <MetricBadge tone="amber">{awardedCount} awarded</MetricBadge>
      </PageHeader>

      <PageSection
        title="Pipeline Health"
        description="Track total application flow, student reach, and how many fellowship programs have active movement right now."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={FileText} value={applications.length} title="Total Applications" description="Current application records across the pipeline" tone="blue" />
          <StatCard icon={Trophy} value={finalistCount} title="Finalists" description="Applications that advanced to finalist status" tone="green" />
          <StatCard icon={Award} value={awardedCount} title="Awarded" description="Award decisions recorded in the current set" tone="amber" />
          <StatCard icon={Users} value={uniqueStudents} title="Students Reached" description={`${uniqueFellowships} fellowships represented in the current pipeline`} tone="violet" />
        </div>
      </PageSection>

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
