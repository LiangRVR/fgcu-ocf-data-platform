import type { Metadata } from "next";
import { Users, Award, FileText, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Dashboard" };

const STAT_CARDS = [
  {
    title: "Total Students",
    value: "—",
    description: "Tracked in the system",
    icon: Users,
  },
  {
    title: "Active Fellowships",
    value: "—",
    description: "Open for applications",
    icon: Award,
  },
  {
    title: "Applications",
    value: "—",
    description: "In progress or submitted",
    icon: FileText,
  },
  {
    title: "Awards This Year",
    value: "—",
    description: "Fellowships awarded",
    icon: TrendingUp,
  },
];

/**
 * Dashboard overview page — stat cards and recent activity.
 * Data will be fetched from Supabase once the schema is in place.
 */
export default function DashboardPage() {
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
              Recent activity will appear here once data is connected.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
