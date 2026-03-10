import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Award,
  Users,
  Star,
  Trophy,
  FilePlus,
  BookOpen,
} from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"] & {
  student: { student_id: number; full_name: string } | null;
};
type ScholarshipHistory = Database["public"]["Tables"]["scholarship_history"]["Row"] & {
  student: { student_id: number; full_name: string } | null;
};

interface FellowshipDetailPageProps {
  params: Promise<{ id: string }>;
}

async function getFellowship(id: number): Promise<Fellowship | null> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("fellowship")
      .select("*")
      .eq("fellowship_id", id)
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

async function getApplications(fellowshipId: number): Promise<Application[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("application")
      .select("*, student(student_id, full_name)")
      .eq("fellowship_id", fellowshipId)
      .order("application_id", { ascending: false });
    if (error) return [];
    return (data as Application[]) || [];
  } catch {
    return [];
  }
}

async function getScholarshipHistory(fellowshipId: number): Promise<ScholarshipHistory[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("scholarship_history")
      .select("*, student(student_id, full_name)")
      .eq("fellowship_id", fellowshipId);
    if (error) return [];
    return (data as ScholarshipHistory[]) || [];
  } catch {
    return [];
  }
}

function stageBadgeClass(stage: string): string {
  switch (stage) {
    case "Started":
      return "border-gray-200 bg-gray-100 text-gray-700";
    case "Submitted":
      return "border-blue-200 bg-blue-100 text-blue-800";
    case "Under Review":
      return "border-amber-200 bg-amber-100 text-amber-800";
    case "Semi-Finalist":
      return "border-purple-200 bg-purple-100 text-purple-800";
    case "Finalist":
      return "border-green-200 bg-green-100 text-green-800";
    case "Awarded":
      return "border-emerald-200 bg-emerald-100 text-emerald-800 font-semibold";
    case "Rejected":
      return "border-red-200 bg-red-100 text-red-700";
    default:
      return "border-gray-200 bg-gray-100 text-gray-700";
  }
}

export default async function FellowshipDetailPage({ params }: FellowshipDetailPageProps) {
  const { id } = await params;
  const fellowshipId = parseInt(id);

  if (isNaN(fellowshipId)) {
    notFound();
  }

  const [fellowship, applications, scholarshipHistory] = await Promise.all([
    getFellowship(fellowshipId),
    getApplications(fellowshipId),
    getScholarshipHistory(fellowshipId),
  ]);

  if (!fellowship) {
    notFound();
  }

  const finalistCount = applications.filter((a) => a.is_finalist).length;
  const semiFinalistCount = applications.filter((a) => a.is_semi_finalist).length;
  const awardedCount = applications.filter((a) => a.stage_of_application === "Awarded").length;

  return (
    <>
      <PageHeader
        title={fellowship.fellowship_name}
        description={`Fellowship ID: ${fellowship.fellowship_id}`}
      >
        <div className="flex items-center gap-2">
          <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
            <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
              <FilePlus className="mr-2 h-4 w-4" />
              Add Application
            </Button>
          </Link>
          <Link href="/fellowships">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
      </PageHeader>

      {/* Summary stat strip */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total Applications", value: applications.length, icon: Award, color: "text-purple-600", bg: "bg-purple-50" },
          { label: "Semi-Finalists", value: semiFinalistCount, icon: Users, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Finalists", value: finalistCount, icon: Star, color: "text-green-600", bg: "bg-green-50" },
          { label: "Awarded", value: awardedCount, icon: Trophy, color: "text-amber-600", bg: "bg-amber-50" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="border-gray-200 shadow-sm">
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{value}</div>
                <div className="text-xs text-slate-500">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-6">
        {/* Applications Table */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Applications
              {applications.length > 0 && (
                <span className="ml-2 text-sm font-normal text-slate-500">
                  ({applications.length})
                </span>
              )}
            </CardTitle>
            <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <FilePlus className="mr-1.5 h-3.5 w-3.5" />
                Add Application
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {applications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <Award className="h-8 w-8 text-gray-400" />
                </div>
                <p className="mb-3 text-sm text-slate-500">
                  No applications for this fellowship yet.
                </p>
                <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
                  <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
                    <FilePlus className="mr-2 h-4 w-4" />
                    Add First Application
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                        Student
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                        Stage
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                        Destination
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
                        Semi-Fin.
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
                        Finalist
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {applications.map((app) => (
                      <tr key={app.application_id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium">
                          <Link
                            href={`/students/${app.student_id}`}
                            className="text-slate-900 hover:text-[#006747] hover:underline"
                          >
                            {app.student?.full_name ?? `Student #${app.student_id}`}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant="secondary"
                            className={`rounded-full border px-2 py-0.5 text-xs ${stageBadgeClass(app.stage_of_application)}`}
                          >
                            {app.stage_of_application}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {app.destination_country ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {app.is_semi_finalist ? (
                            <Badge className="rounded-full border border-purple-200 bg-purple-100 px-2 py-0.5 text-xs text-purple-800 hover:bg-purple-100">
                              Yes
                            </Badge>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {app.is_finalist ? (
                            <Badge className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs text-green-800 hover:bg-green-100">
                              Yes
                            </Badge>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Scholarship History */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Trophy className="h-5 w-5 text-amber-500" />
              Scholarship History
              {scholarshipHistory.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({scholarshipHistory.length} award{scholarshipHistory.length !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
            <Link href={`/scholarship-history?add=1&fellowship_id=${fellowship.fellowship_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                Add History
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {scholarshipHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <Trophy className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-sm text-slate-500">
                  No scholarship history recorded for this fellowship.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {scholarshipHistory.map((record) => (
                  <Link key={record.history_id} href={`/students/${record.student_id}`}>
                    <Badge className="border-amber-200 bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-200 cursor-pointer">
                      <Users className="mr-1.5 h-3.5 w-3.5" />
                      {record.student?.full_name ?? `Student #${record.student_id}`}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
