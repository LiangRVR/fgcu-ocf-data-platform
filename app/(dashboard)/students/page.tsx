import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
 * KPI Card Component
 */
function KPICard({
  icon: Icon,
  value,
  label,
  bgColor,
}: {
  icon: React.ElementType;
  value: number;
  label: string;
  bgColor: string;
}) {
  return (
    <Card className="border-gray-200 shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="text-3xl font-semibold text-slate-900">{value}</div>
            <div className="text-sm text-slate-500">{label}</div>
          </div>
          <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${bgColor}`}>
            <Icon className="h-6 w-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * KPI Cards Loading Skeleton
 */
function KPICardsSkeleton() {
  return (
    <>
      {[...Array(4)].map((_, i) => (
        <Card key={i} className="border-gray-200 shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-9 w-16" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-12 w-12 rounded-lg" />
            </div>
          </CardContent>
        </Card>
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
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">{visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""}</span> have had no applications recorded.
        These are candidates to reach out to about fellowship opportunities.
      </div>
    );
  } else if (view === "no-advising") {
    visibleStudents = students.filter((s) => !ids.withMeetings.has(s.student_id));
    exceptionBanner = (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="font-semibold">{visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""}</span> have never had an advising meeting.
        Consider scheduling outreach sessions.
      </div>
    );
  } else if (view === "prior-award") {
    visibleStudents = students.filter(
      (s) => ids.withHistory.has(s.student_id) && ids.withApps.has(s.student_id),
    );
    exceptionBanner = (
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        <span className="font-semibold">{visibleStudents.length} student{visibleStudents.length !== 1 ? "s" : ""}</span> have prior scholarship history <em>and</em> a current application.
        Strong candidates for advisor follow-up.
      </div>
    );
  }

  return (
    <>
      {/* Statistics Cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          icon={Users}
          value={stats.totalStudents}
          label="Total Students"
          bgColor="bg-slate-100 text-slate-600"
        />
        <KPICard
          icon={GraduationCap}
          value={stats.chStudents}
          label="CH Students"
          bgColor="bg-emerald-50 text-emerald-600"
        />
        <KPICard
          icon={FileText}
          value={stats.activeApplications}
          label="Active Applications"
          bgColor="bg-indigo-50 text-indigo-600"
        />
        <KPICard
          icon={Award}
          value={stats.fellowshipsAvailable}
          label="Fellowships Available"
          bgColor="bg-amber-50 text-amber-600"
        />
      </div>

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

  return (
    <>
      <PageHeader
        title="Students"
        description="Manage fellowship-eligible students"
      />

      {/* Exception view pill bar */}
      <div className="mb-6 flex flex-wrap gap-2">
        {EXCEPTION_VIEWS.map(({ key, label, color }) => {
          const isActive = view === key;
          let cls: string;
          if (isActive && key === "all") {
            cls = "bg-slate-900 text-white border-slate-900";
          } else if (isActive && color === "emerald") {
            cls = "bg-emerald-700 text-white border-emerald-700";
          } else if (isActive) {
            cls = "bg-amber-600 text-white border-amber-600";
          } else if (color === "amber") {
            cls = "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-400";
          } else if (color === "emerald") {
            cls = "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400";
          } else {
            cls = "border-gray-200 bg-white text-slate-600 hover:border-slate-400";
          }
          return (
            <Link
              key={key}
              href={key === "all" ? "/students" : `/students?view=${key}`}
              className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors ${cls}`}
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
            <Card className="border-gray-200 shadow-sm">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-64 w-full" />
                </div>
              </CardContent>
            </Card>
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
