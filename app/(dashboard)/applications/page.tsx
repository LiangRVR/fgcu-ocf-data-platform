import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import {
  AppCard as Card,
  AppCardContent as CardContent,
  AppCardDescription,
  AppCardHeader as CardHeader,
  AppCardTitle as CardTitle,
} from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { ApplicationsTable } from "@/components/applications/applications-table";
import type { Database } from "@/types/database";
import { AlertTriangle, Award, FileText, Trophy, Users } from "lucide-react";

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

type ApplicationsResult =
  | { ok: true; applications: Application[] }
  | { ok: false };

type StudentsResult =
  | { ok: true; students: StudentRow[] }
  | { ok: false };

type FellowshipsResult =
  | { ok: true; fellowships: FellowshipRow[] }
  | { ok: false };

export async function getApplications(): Promise<ApplicationsResult> {
  try {
    // Client construction happens inside the failure boundary: a THROWN
    // construction/request-context error also yields { ok: false } so the page
    // renders the explicit unavailable state.
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("application")
      .select(`*, student(full_name), fellowship(fellowship_name)`)
      .order("application_id", { ascending: false });

    if (error) {
      return { ok: false };
    }
    return { ok: true, applications: (data as Application[]) || [] };
  } catch {
    return { ok: false };
  }
}

export async function getStudents(): Promise<StudentsResult> {
  try {
    // Client construction happens inside the failure boundary: a THROWN
    // construction/request-context error also yields { ok: false } so the page
    // renders the explicit unavailable state.
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("student")
      .select("student_id, full_name")
      .order("full_name", { ascending: true });

    if (error) {
      return { ok: false };
    }
    return { ok: true, students: data || [] };
  } catch {
    return { ok: false };
  }
}

export async function getFellowships(): Promise<FellowshipsResult> {
  try {
    // Client construction happens inside the failure boundary: a THROWN
    // construction/request-context error also yields { ok: false } so the page
    // renders the explicit unavailable state.
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("fellowship")
      .select("fellowship_id, fellowship_name")
      .order("fellowship_name", { ascending: true });

    if (error) {
      return { ok: false };
    }
    return { ok: true, fellowships: data || [] };
  } catch {
    return { ok: false };
  }
}

export function ApplicationsUnavailable() {
  return (
    <PageSection
      title="Applications unavailable"
      description="The application service could not be reached."
    >
      <Card className="border-amber-200 bg-amber-50/60 shadow-sm" role="alert">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" aria-hidden="true" />
            <div>
              <CardTitle className="text-base font-semibold text-slate-900">
                Applications are currently unavailable
              </CardTitle>
              <AppCardDescription className="mt-1 text-slate-600">
                We couldn&apos;t load the latest application data. Refresh the page to try again.
              </AppCardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <a
            href="/applications"
            className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            Refresh applications
          </a>
        </CardContent>
      </Card>
    </PageSection>
  );
}

export default async function ApplicationsPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const defaultFellowshipId = params.fellowship_id;
  const initialStageFilter = params.stage;
  const initialSearchQuery = params.fellowship;

  const [applicationsResult, studentsResult, fellowshipsResult] = await Promise.all([
    getApplications(),
    getStudents(),
    getFellowships(),
  ]);

  if (!applicationsResult.ok || !studentsResult.ok || !fellowshipsResult.ok) {
    return (
      <>
        <PageHeader
          eyebrow="Application Pipeline"
          title="Applications"
          description="Track fellowship applications from first draft through finalist and award decisions."
        />
        <div className="space-y-8">
          <ApplicationsUnavailable />
        </div>
      </>
    );
  }

  const applications = applicationsResult.applications;
  const students = studentsResult.students;
  const fellowships = fellowshipsResult.fellowships;

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
