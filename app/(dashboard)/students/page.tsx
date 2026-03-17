import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { Users, GraduationCap, FileText, Award } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { StudentsTable } from "@/components/students/students-table";
import type { Database } from "@/types/database";
import Link from "next/link";

export const metadata: Metadata = { title: "Students" };

type Student = Database["public"]["Tables"]["student"]["Row"];

type ExceptionView = "all" | "no-apps" | "no-advising" | "prior-award";

interface Props {
  searchParams: Promise<{ standing?: string; flag?: string; view?: string }>;
}

/**
 * Fetch all students from the database
 */
async function getStudents(): Promise<Student[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("student")
      .select("*")
      .order("student_id", { ascending: false });

    if (error) {
      console.error("Error fetching students:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error fetching students:", error);
    return [];
  }
}

async function getApplicationsCount(): Promise<number> {
  const supabase = createServerClient();
  try {
    const { count } = await supabase
      .from("application")
      .select("*", { count: "exact", head: true });
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function getExceptionIds(): Promise<{
  withApps: Set<number>;
  withMeetings: Set<number>;
  withHistory: Set<number>;
}> {
  const supabase = createServerClient();
  try {
    const [appsRes, meetingsRes, historyRes] = await Promise.all([
      supabase.from("application").select("student_id"),
      supabase.from("advising_meeting").select("student_id"),
      supabase.from("scholarship_history").select("student_id"),
    ]);
    return {
      withApps:     new Set((appsRes.data     ?? []).map((r) => r.student_id)),
      withMeetings: new Set((meetingsRes.data ?? []).map((r) => r.student_id)),
      withHistory:  new Set((historyRes.data  ?? []).map((r) => r.student_id)),
    };
  } catch {
    return { withApps: new Set(), withMeetings: new Set(), withHistory: new Set() };
  }
}

async function getFellowshipsCount(): Promise<number> {
  const supabase = createServerClient();
  try {
    const { count } = await supabase
      .from("fellowship")
      .select("*", { count: "exact", head: true });
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Calculate dashboard statistics
 */
function getStatistics(
  students: Student[],
  activeApplications: number,
  fellowshipsAvailable: number,
) {
  return {
    totalStudents: students.length,
    chStudents: students.filter((s) => s.is_ch_student).length,
    activeApplications,
    fellowshipsAvailable,
  };
}

/**
 * KPI Cards Loading Skeleton
 */
function KPICardsSkeleton() {
  return (
    <>
      {[...Array(4)].map((_, i) => (
        <AppCard key={i}>
          <AppCardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-9 w-16" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-12 w-12 rounded-lg" />
            </div>
          </AppCardContent>
        </AppCard>
      ))}
    </>
  );
}

/**
 * Students Content Component
 */
async function StudentsContent({
  initialStandingFilter,
  initialStatusFilter,
  view,
}: {
  initialStandingFilter?: string;
  initialStatusFilter?: string;
  view: ExceptionView;
}) {
  const [students, activeApplications, fellowshipsAvailable, ids] = await Promise.all([
    getStudents(),
    getApplicationsCount(),
    getFellowshipsCount(),
    getExceptionIds(),
  ]);
  const stats = getStatistics(students, activeApplications, fellowshipsAvailable);

  // Exception view filtering
  let visibleStudents = students;
  let exceptionBanner: React.ReactNode = null;

  if (view === "no-apps") {
    visibleStudents = students.filter((s) => !ids.withApps.has(s.student_id));
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900">Application outreach queue</p>
            <p className="text-sm text-amber-800">
              {visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""} have had no applications recorded. These are candidates to reach out to about fellowship opportunities.
            </p>
          </div>
          <MetricBadge tone="amber">{visibleStudents.length} open</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  } else if (view === "no-advising") {
    visibleStudents = students.filter((s) => !ids.withMeetings.has(s.student_id));
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900">Advising coverage gap</p>
            <p className="text-sm text-amber-800">
              {visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""} have never had an advising meeting. Consider scheduling outreach sessions.
            </p>
          </div>
          <MetricBadge tone="amber">{visibleStudents.length} unseen</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  } else if (view === "prior-award") {
    visibleStudents = students.filter(
      (s) => ids.withHistory.has(s.student_id) && ids.withApps.has(s.student_id),
    );
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-emerald-200/70 bg-emerald-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-emerald-900">High-priority follow-up</p>
            <p className="text-sm text-emerald-800">
              {visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""} have prior scholarship history and a current application. Strong candidates for advisor follow-up.
            </p>
          </div>
          <MetricBadge tone="green">{visibleStudents.length} priority</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  }

  return (
    <>
      <PageSection
        title="Student Coverage"
        description="Top-line student, application, and program metrics to orient advising and outreach work."
        className="mb-6"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={Users} value={stats.totalStudents} title="Total Students" description="Tracked in the student roster" tone="blue" />
          <StatCard icon={GraduationCap} value={stats.chStudents} title="CH Students" description="Students marked for CH advising" tone="green" />
          <StatCard icon={FileText} value={stats.activeApplications} title="Active Applications" description="Current application records on file" tone="violet" />
          <StatCard icon={Award} value={stats.fellowshipsAvailable} title="Fellowships Available" description="Programs available for matching" tone="amber" />
        </div>
      </PageSection>

      {exceptionBanner}

      {/* Students Table */}
      <StudentsTable
        initialStudents={visibleStudents}
        initialStandingFilter={view === "all" ? initialStandingFilter : undefined}
        initialStatusFilter={view === "all" ? initialStatusFilter : undefined}
      />
    </>
  );
}

const EXCEPTION_VIEWS: { key: ExceptionView; label: string; description: string; color: string }[] = [
  { key: "all",         label: "All Students",        description: "",                                     color: "" },
  { key: "no-apps",     label: "No Applications",     description: "Never submitted an application",        color: "amber" },
  { key: "no-advising", label: "No Advising",          description: "Never had an advising meeting",         color: "amber" },
  { key: "prior-award", label: "Prior Award + Active", description: "Has scholarship history & an application", color: "emerald" },
];

export default async function StudentsPage({ searchParams }: Props) {
  const params = await searchParams;
  const view = (params.view ?? "all") as ExceptionView;
  const activeView = EXCEPTION_VIEWS.find((item) => item.key === view) ?? EXCEPTION_VIEWS[0];

  return (
    <>
      <PageHeader
        eyebrow="Student Operations"
        title="Students"
        description="Manage the fellowship student roster, identify outreach gaps, and route students into the right advising workflows."
      >
        <MetricBadge tone="blue">Roster management</MetricBadge>
        <MetricBadge tone={view === "prior-award" ? "green" : view === "all" ? "slate" : "amber"}>{activeView.label}</MetricBadge>
      </PageHeader>

      {/* Exception view pill bar */}
      <div className="mb-8 flex flex-wrap gap-2">
        {EXCEPTION_VIEWS.map(({ key, label, color }) => {
          const isActive = view === key;
          let cls: string;
          if (isActive && key === "all") {
            cls = "border-slate-900 bg-slate-900 text-white shadow-sm";
          } else if (isActive && color === "emerald") {
            cls = "border-emerald-700 bg-emerald-700 text-white shadow-sm";
          } else if (isActive) {
            cls = "border-amber-600 bg-amber-600 text-white shadow-sm";
          } else if (color === "amber") {
            cls = "border-amber-200 bg-amber-50/80 text-amber-700 hover:border-amber-400 hover:bg-amber-50";
          } else if (color === "emerald") {
            cls = "border-emerald-200 bg-emerald-50/80 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-50";
          } else {
            cls = "border-border bg-white/80 text-slate-600 hover:border-slate-400 hover:bg-white";
          }
          return (
            <Link
              key={key}
              href={key === "all" ? "/students" : `/students?view=${key}`}
              className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${cls}`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <Suspense
        fallback={
          <>
            <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KPICardsSkeleton />
            </div>
            <AppCard>
              <AppCardContent className="p-6">
                <div className="space-y-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-64 w-full" />
                </div>
              </AppCardContent>
            </AppCard>
          </>
        }
      >
        <StudentsContent
          initialStandingFilter={params.standing}
          initialStatusFilter={params.flag}
          view={view}
        />
      </Suspense>
    </>
  );
}
