import type { Metadata } from "next";
import { Users, Award, FileText, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Fetch dashboard statistics from Supabase
 */
async function getDashboardStats() {
  const supabase = createServerClient();

  try {
    // Fetch counts in parallel
    const [studentsRes, fellowshipsRes, applicationsRes, awardsRes] =
      await Promise.all([
        supabase.from("student").select("student_id", { count: "exact", head: true }),
        supabase
          .from("fellowship")
          .select("fellowship_id", { count: "exact", head: true }),
        supabase
          .from("application")
          .select("application_id", { count: "exact", head: true }),
        supabase
          .from("application")
          .select("application_id", { count: "exact", head: true })
          .eq("is_finalist", true),
      ]);

    return {
      totalStudents: studentsRes.count ?? 0,
      activeFellowships: fellowshipsRes.count ?? 0,
      totalApplications: applicationsRes.count ?? 0,
      awardsThisYear: awardsRes.count ?? 0,
    };
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return {
      totalStudents: 0,
      activeFellowships: 0,
      totalApplications: 0,
      awardsThisYear: 0,
    };
  }
}

/**
 * Dashboard overview page — stat cards and recent activity.
 */
export default async function DashboardPage() {
  const stats = await getDashboardStats();

  const STAT_CARDS = [
    {
      title: "Total Students",
      value: stats.totalStudents.toString(),
      description: "Tracked in the system",
      icon: Users,
      bgColor: "bg-blue-100",
      iconColor: "text-blue-600",
    },
    {
      title: "Active Fellowships",
      value: stats.activeFellowships.toString(),
      description: "Open for applications",
      icon: Award,
      bgColor: "bg-amber-100",
      iconColor: "text-amber-600",
    },
    {
      title: "Applications",
      value: stats.totalApplications.toString(),
      description: "In progress or submitted",
      icon: FileText,
      bgColor: "bg-purple-100",
      iconColor: "text-purple-600",
    },
    {
      title: "Awards This Year",
      value: stats.awardsThisYear.toString(),
      description: "Fellowships awarded",
      icon: TrendingUp,
      bgColor: "bg-green-100",
      iconColor: "text-green-600",
    },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Welcome to the OCF Fellowship Management System."
      />

      {/* Stat cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} className="border-gray-200 shadow-sm">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${stat.bgColor}`}>
                    <Icon className={`h-5 w-5 ${stat.iconColor}`} />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold text-slate-900">{stat.value}</div>
                    <div className="text-sm text-slate-500">{stat.title}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Placeholder recent activity */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold text-slate-900">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">
            {stats.totalStudents === 0
              ? "No data yet. Add some students, fellowships, and applications to get started."
              : "Recent activity will appear here."}
          </p>
        </CardContent>
      </Card>
    </>
  );
}
