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
    },
    {
      title: "Active Fellowships",
      value: stats.activeFellowships.toString(),
      description: "Open for applications",
      icon: Award,
    },
    {
      title: "Applications",
      value: stats.totalApplications.toString(),
      description: "In progress or submitted",
      icon: FileText,
    },
    {
      title: "Awards This Year",
      value: stats.awardsThisYear.toString(),
      description: "Fellowships awarded",
      icon: TrendingUp,
    },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Welcome to the OCF Fellowship Management System."
      />

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAT_CARDS.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.title}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stat.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Placeholder recent activity */}
      <div className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {stats.totalStudents === 0
                ? "No data yet. Add some students, fellowships, and applications to get started."
                : "Recent activity will appear here."}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
