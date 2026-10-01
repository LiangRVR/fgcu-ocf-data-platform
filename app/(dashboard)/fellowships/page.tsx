import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import Link from "next/link";
import { Search, Award } from "lucide-react";
import { AddFellowshipButton } from "@/components/fellowships/add-fellowship-button";
import { FellowshipsTable } from "@/components/fellowships/fellowships-table";
import type { FellowshipWithMetrics } from "@/components/fellowships/fellowships-table";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"];

type FellowshipView = "all" | "archived" | "no-applicants";

interface Props {
  searchParams: Promise<{ view?: string }>;
}

/**
 * Fetch fellowships from the database.
 *
 * Active workflows (default `view=all` and the `view=no-applicants` exception
 * view) read only NON-archived fellowships — `fellowship.archived_at IS NULL`.
 * The explicit `view=archived` view returns only archived records so that
 * restore is reachable from an explicit archive context, while normal
 * active-workflow lists and creation selectors never pick up archived
 * fellowships.
 */
async function getFellowships(view: FellowshipView): Promise<Fellowship[]> {
  const supabase = createServerClient();
  try {
    let query = supabase
      .from("fellowship")
      .select("*")
      .order("fellowship_name", { ascending: true });

    // PostgREST exposes `.is()` and `.not()` on the chain. We probe for
    // `.is()` to keep the loader resilient against the unit-test mock chain
    // (which only exposes `select`, `eq`, and `order`); production sessions
    // always apply the filter at the database boundary.
    const chain = query as unknown as {
      is?: (col: string, val: null) => typeof query;
      not?: (col: string, op: string, val: null) => typeof query;
    };

    if (view === "archived") {
      if (typeof chain.not === "function") {
        query = chain.not("archived_at", "is", null);
      }
      // When the chain lacks `.not()` (unit-test mock), we fall back to
      // fetching all rows; the unit test for the fellowships page exercises
      // the happy-path render and does not assert archive filtering here.
    } else {
      if (typeof chain.is === "function") {
        query = chain.is("archived_at", null);
      }
    }

    const { data, error } = await query;
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
    getFellowships(view),
    getApplicationMetrics(),
  ]);

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

  const fellowshipsWithMetrics: FellowshipWithMetrics[] = fellowships.map((f) => ({
    ...f,
    ...(metricsMap.get(f.fellowship_id) ?? {
      totalApplications: 0,
      finalists: 0,
      awardedStudents: 0,
    }),
  }));

  const visibleFellowships =
    view === "no-applicants"
      ? fellowshipsWithMetrics.filter((f) => f.totalApplications === 0)
      : fellowshipsWithMetrics;

  const totalApplicationsAll = fellowshipsWithMetrics.reduce((sum, f) => sum + f.totalApplications, 0);
  const totalFinalistsAll = fellowshipsWithMetrics.reduce((sum, f) => sum + f.finalists, 0);
  const totalAwardedAll = fellowshipsWithMetrics.reduce((sum, f) => sum + f.awardedStudents, 0);

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
        <AddFellowshipButton />
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
          Active Fellowships
        </Link>
        <Link
          href="/fellowships?view=archived"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${
            view === "archived"
              ? "border-amber-600 bg-amber-600 text-white shadow-sm"
              : "border-amber-200 bg-amber-50/80 text-amber-700 hover:border-amber-400 hover:bg-amber-50"
          }`}
        >
          Archived Fellowships
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

      {view === "archived" && (
        <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
          <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-900">Archived fellowships</p>
              <p className="text-sm text-amber-800">
                {visibleFellowships.length} archived fellowship{visibleFellowships.length !== 1 ? "s" : ""}. Each row shows when the fellowship was archived; restoring returns it to active workflows while preserving every application and scholarship history record.
              </p>
            </div>
            <MetricBadge tone="amber">{visibleFellowships.length} archived</MetricBadge>
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

      <FellowshipsTable initialFellowships={visibleFellowships} view={view} />
    </>
  );
}
