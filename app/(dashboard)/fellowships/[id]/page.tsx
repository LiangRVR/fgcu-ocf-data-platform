import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-section";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityHeader } from "@/components/ui/entity-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import {
  ArrowLeft,
  Award,
  Users,
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
      <EntityHeader
        kicker="Program Detail"
        title={fellowship.fellowship_name}
        description={`Fellowship ID ${fellowship.fellowship_id}`}
        actions={
          <>
            <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
              <Button size="sm">
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
          </>
        }
        summary={
          <>
            {[
              { label: "Total Applications", value: applications.length },
              { label: "Semi-Finalists", value: semiFinalistCount },
              { label: "Finalists", value: finalistCount },
              { label: "Awarded", value: awardedCount },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-400">{item.label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{item.value}</p>
              </div>
            ))}
          </>
        }
      />

      <div className="space-y-6">
        <DetailSection
          title="Applications"
          description="Current application activity attached to this fellowship."
          icon={<Award className="h-5 w-5" />}
          actions={
            <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
              <FilePlus className="mr-2 h-4 w-4" />
              Add Application
            </Button>
          </Link>
          }
        >
            {applications.length === 0 ? (
              <EmptyState
                icon={Award}
                title="No applications yet"
                description="No applications are attached to this fellowship yet."
                compact
                action={
                  <Link href={`/applications?add=1&fellowship_id=${fellowship.fellowship_id}`}>
                    <Button size="sm">
                      <FilePlus className="mr-2 h-4 w-4" />
                      Add First Application
                    </Button>
                  </Link>
                }
              />
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {applications.map((app) => (
                    <div key={app.application_id} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <Link
                          href={`/students/${app.student_id}`}
                          className="min-w-0 text-sm font-semibold text-slate-900 hover:text-primary hover:underline"
                        >
                          <span className="line-clamp-2">{app.student?.full_name ?? `Student #${app.student_id}`}</span>
                        </Link>
                        <MetricBadge
                          tone={app.stage_of_application === "Awarded" ? "amber" : app.stage_of_application === "Finalist" ? "green" : app.stage_of_application === "Semi-Finalist" ? "purple" : app.stage_of_application === "Rejected" ? "red" : app.stage_of_application === "Under Review" ? "amber" : app.stage_of_application === "Submitted" ? "blue" : "slate"}
                          className={stageBadgeClass(app.stage_of_application)}
                        >
                          {app.stage_of_application}
                        </MetricBadge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricBadge tone="slate">{app.destination_country ?? "No destination"}</MetricBadge>
                        {app.is_semi_finalist ? <MetricBadge tone="purple">Semi-Finalist</MetricBadge> : null}
                        {app.is_finalist ? <MetricBadge tone="green">Finalist</MetricBadge> : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50">
                        <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-4 sm:py-3">
                          Student
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-4 sm:py-3">
                          Stage
                        </th>
                        <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-4 sm:py-3 md:table-cell">
                          Destination
                        </th>
                        <th className="hidden px-3 py-2 text-center text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-4 sm:py-3 lg:table-cell">
                          Semi-Fin.
                        </th>
                        <th className="hidden px-3 py-2 text-center text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-4 sm:py-3 lg:table-cell">
                          Finalist
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {applications.map((app) => (
                        <tr key={app.application_id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium sm:px-4 sm:py-3">
                            <Link
                              href={`/students/${app.student_id}`}
                              className="text-slate-900 hover:text-[#006747] hover:underline"
                            >
                              {app.student?.full_name ?? `Student #${app.student_id}`}
                            </Link>
                          </td>
                          <td className="px-3 py-2 sm:px-4 sm:py-3">
                            <MetricBadge tone={app.stage_of_application === "Awarded" ? "amber" : app.stage_of_application === "Finalist" ? "green" : app.stage_of_application === "Semi-Finalist" ? "purple" : app.stage_of_application === "Rejected" ? "red" : app.stage_of_application === "Under Review" ? "amber" : app.stage_of_application === "Submitted" ? "blue" : "slate"} className={stageBadgeClass(app.stage_of_application)}>
                              {app.stage_of_application}
                            </MetricBadge>
                          </td>
                          <td className="hidden px-3 py-2 text-slate-600 sm:px-4 sm:py-3 md:table-cell">
                            {app.destination_country ?? "—"}
                          </td>
                          <td className="hidden px-3 py-2 text-center sm:px-4 sm:py-3 lg:table-cell">
                            {app.is_semi_finalist ? (
                              <MetricBadge tone="purple">Yes</MetricBadge>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                          <td className="hidden px-3 py-2 text-center sm:px-4 sm:py-3 lg:table-cell">
                            {app.is_finalist ? (
                              <MetricBadge tone="green">Yes</MetricBadge>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
        </DetailSection>

        <DetailSection
          title="Scholarship History"
          description="Students with recorded prior awards tied to this fellowship."
          icon={<Trophy className="h-5 w-5" />}
          actions={
            <Link href={`/scholarship-history?add=1&fellowship_id=${fellowship.fellowship_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                Add History
              </Button>
            </Link>
          }
        >
            {scholarshipHistory.length === 0 ? (
              <EmptyState
                icon={Trophy}
                title="No scholarship history recorded"
                description="No historical awards are linked to this fellowship yet."
                compact
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {scholarshipHistory.map((record) => (
                  <Link key={record.history_id} href={`/students/${record.student_id}`}>
                    <MetricBadge tone="amber" className="cursor-pointer px-3 py-1 text-sm font-medium hover:bg-amber-200">
                      <Users className="mr-1.5 h-3.5 w-3.5" />
                      {record.student?.full_name ?? `Student #${record.student_id}`}
                    </MetricBadge>
                  </Link>
                ))}
              </div>
            )}
        </DetailSection>
      </div>
    </>
  );
}
