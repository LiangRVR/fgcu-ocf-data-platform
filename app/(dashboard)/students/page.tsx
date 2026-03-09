import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, GraduationCap, FileText, Award } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { StudentsTable } from "@/components/students/students-table";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Students" };

type Student = Database["public"]["Tables"]["student"]["Row"];

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
async function StudentsContent() {
  const [students, activeApplications, fellowshipsAvailable] = await Promise.all([
    getStudents(),
    getApplicationsCount(),
    getFellowshipsCount(),
  ]);
  const stats = getStatistics(students, activeApplications, fellowshipsAvailable);

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

      {/* Students Table */}
      <StudentsTable initialStudents={students} />
    </>
  );
}

export default async function StudentsPage() {
  return (
    <>
      <PageHeader
        title="Students"
        description="Manage fellowship-eligible students"
      />

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
        <StudentsContent />
      </Suspense>
    </>
  );
}
