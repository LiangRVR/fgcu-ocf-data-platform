import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import Link from "next/link";
import { Plus, Search, Eye, Trash2, Award } from "lucide-react";
import { FellowshipEditButton } from "@/components/fellowships/fellowship-edit-button";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"];

type FellowshipView = "all" | "no-applicants";

interface Props {
  searchParams: Promise<{ view?: string }>;
}

interface FellowshipWithMetrics extends Fellowship {
  totalApplications: number;
  finalists: number;
  awardedStudents: number;
}

/**
 * Fetch all fellowships from the database
 */
async function getFellowships(): Promise<Fellowship[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("fellowship")
      .select("*")
      .order("fellowship_name", { ascending: true });

    if (error) {
      console.error("Error fetching fellowships:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error fetching fellowships:", error);
    return [];
  }
}

/**
 * Fetch application metrics grouped by fellowship
 */
async function getApplicationMetrics(): Promise<Application[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("application")
      .select("fellowship_id, is_finalist, stage_of_application");

    if (error) {
      console.error("Error fetching application metrics:", error);
      return [];
    }

    return (data as Application[]) || [];
  } catch {
    return [];
  }
}

export default async function FellowshipsPage({ searchParams }: Props) {
  const params = await searchParams;
  const view = (params.view ?? "all") as FellowshipView;

  const [fellowships, applications] = await Promise.all([
    getFellowships(),
    getApplicationMetrics(),
  ]);

  // Derive per-fellowship metrics from the flat applications list
  const metricsMap = new Map<
    number,
    { totalApplications: number; finalists: number; awardedStudents: number }
  >();
  for (const app of applications) {
    const existing = metricsMap.get(app.fellowship_id) ?? {
      totalApplications: 0,
      finalists: 0,
      awardedStudents: 0,
    };
    existing.totalApplications += 1;
    if (app.is_finalist) existing.finalists += 1;
    if (app.stage_of_application === "Awarded") existing.awardedStudents += 1;
    metricsMap.set(app.fellowship_id, existing);
  }

  const fellowshipsWithMetrics: FellowshipWithMetrics[] = fellowships.map(
    (f) => ({
      ...f,
      ...(metricsMap.get(f.fellowship_id) ?? {
        totalApplications: 0,
        finalists: 0,
        awardedStudents: 0,
      }),
    })
  );

  // Apply exception view filter
  const visibleFellowships =
    view === "no-applicants"
      ? fellowshipsWithMetrics.filter((f) => f.totalApplications === 0)
      : fellowshipsWithMetrics;

  // Summary stats across all fellowships
  const totalApplicationsAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.totalApplications,
    0
  );
  const totalFinalistsAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.finalists,
    0
  );
  const totalAwardedAll = fellowshipsWithMetrics.reduce(
    (sum, f) => sum + f.awardedStudents,
    0
  );

  return (
    <>
      <PageHeader
        eyebrow="Program Portfolio"
        title="Fellowships"
        description="Manage the active fellowship catalog, surface under-promoted programs, and review pipeline performance by program."
      >
        <MetricBadge tone="blue">{fellowshipsWithMetrics.length} programs</MetricBadge>
        <MetricBadge tone="green">{totalFinalistsAll} finalists</MetricBadge>
        <MetricBadge tone="amber">{totalAwardedAll} awarded</MetricBadge>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Fellowship
        </Button>
      </PageHeader>

      {/* Exception view pill bar */}
      <div className="mb-8 flex flex-wrap gap-2">
        <Link
          href="/fellowships"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${
            view === "all"
              ? "border-slate-900 bg-slate-900 text-white shadow-sm"
              : "border-border bg-white/80 text-slate-600 hover:border-slate-400 hover:bg-white"
          }`}
        >
          All Fellowships
        </Link>
        <Link
          href="/fellowships?view=no-applicants"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${
            view === "no-applicants"
              ? "border-amber-600 bg-amber-600 text-white shadow-sm"
              : "border-amber-200 bg-amber-50/80 text-amber-700 hover:border-amber-400 hover:bg-amber-50"
          }`}
        >
          No Applicants Yet
          {view !== "no-applicants" && (
            <span className="ml-1.5 tabular-nums">
              ({fellowshipsWithMetrics.filter((f) => f.totalApplications === 0).length})
            </span>
          )}
        </Link>
      </div>

      {view === "no-applicants" && (
        <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
          <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-900">Promotion candidates</p>
              <p className="text-sm text-amber-800">
                {visibleFellowships.length} fellowship{visibleFellowships.length !== 1 ? "s" : ""} have no applications on record. These may need additional promotion or outreach.
              </p>
            </div>
            <MetricBadge tone="amber">{visibleFellowships.length} open</MetricBadge>
          </AppCardContent>
        </AppCard>
      )}

      <PageSection
        title="Program Health"
        description="Use these metrics to spot coverage gaps and see where applicant flow is concentrating."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Fellowships" value={fellowshipsWithMetrics.length} description="Programs in the current catalog" icon={Award} tone="blue" />
          <StatCard title="Total Applications" value={totalApplicationsAll} description="Applications linked across all programs" icon={Search} tone="violet" />
          <StatCard title="Finalists" value={totalFinalistsAll} description="Applicants marked as finalists" icon={Award} tone="green" />
          <StatCard title="Awarded" value={totalAwardedAll} description="Awarded outcomes across the program set" icon={Award} tone="amber" />
        </div>
      </PageSection>

      <DataToolbar
        className="mb-4"
        leading={
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search fellowships..."
              className="pl-9"
            />
          </div>
        }
      />

      {/* Fellowships Table */}
      <AppCard>
        <AppCardContent className="p-0">
          {visibleFellowships.length === 0 ? (
            <EmptyState
              icon={Award}
              title={view === "no-applicants" ? "All fellowships have applicants" : "No fellowships found"}
              description={
                view === "no-applicants"
                  ? "Every fellowship currently has at least one applicant."
                  : "Get started by adding your first fellowship opportunity."
              }
              action={view === "all" ? (
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Fellowship
                </Button>
              ) : undefined}
            />
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {visibleFellowships.map((fellowship) => (
                  <div key={fellowship.fellowship_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/fellowships/${fellowship.fellowship_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {fellowship.fellowship_name}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                          <span><span className="font-medium text-slate-700">{fellowship.totalApplications}</span> apps</span>
                          <span><span className="font-medium text-slate-700">{fellowship.finalists}</span> finalists</span>
                          <span><span className="font-medium text-slate-700">{fellowship.awardedStudents}</span> awarded</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Link href={`/fellowships/${fellowship.fellowship_id}`}>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-slate-900" title="View fellowship">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                        <FellowshipEditButton
                          fellowshipId={fellowship.fellowship_id}
                          fellowshipName={fellowship.fellowship_name}
                        />
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-600 hover:text-red-600" title="Delete fellowship">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">Name</th>
                    <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:table-cell sm:px-6 sm:py-3">Applications</th>
                    <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">Finalists</th>
                    <th className="hidden px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">Awarded</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {visibleFellowships.map((fellowship) => (
                    <tr
                      key={fellowship.fellowship_id}
                      className="motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/fellowships/${fellowship.fellowship_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {fellowship.fellowship_name}
                        </Link>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:table-cell sm:px-6 sm:py-4">
                        <span className="text-sm font-medium text-slate-700">{fellowship.totalApplications}</span>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:px-6 sm:py-4 md:table-cell">
                        <span className="text-sm font-medium text-slate-700">{fellowship.finalists}</span>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 text-right sm:px-6 sm:py-4 md:table-cell">
                        <span className="text-sm font-medium text-slate-700">
                          {fellowship.awardedStudents}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/fellowships/${fellowship.fellowship_id}`}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-slate-600 hover:text-slate-900"
                              title="View fellowship"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                          <FellowshipEditButton
                            fellowshipId={fellowship.fellowship_id}
                            fellowshipName={fellowship.fellowship_name}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete fellowship"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </AppCardContent>
      </AppCard>

      {/* Pagination */}
      {visibleFellowships.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-500">
            Showing <span className="font-medium">1</span>–<span className="font-medium">{visibleFellowships.length}</span> of{" "}
            <span className="font-medium">{visibleFellowships.length}</span> fellowships
          </div>
          <div className="flex gap-2 self-start sm:self-auto">
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
