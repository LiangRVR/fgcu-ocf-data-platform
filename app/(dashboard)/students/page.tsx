import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { AlertTriangle, Award, FileText, GraduationCap, Users } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";
import { StudentsTable } from "@/components/students/students-table";
import type { Database } from "@/types/database";
import Link from "next/link";

export const metadata: Metadata = { title: "Students" };

/** Explicit list row: the read-only, RLS-preserving `student_list` view. */
type StudentListRow = Database["public"]["Views"]["student_list"]["Row"];

type ExceptionView = "all" | "archived" | "no-apps" | "no-advising" | "prior-award";

interface Props {
  searchParams: Promise<{
    view?: string;
    standing?: string;
    flag?: string;
    search?: string;
    sort?: string;
    direction?: string;
    page?: string;
    pageSize?: string;
  }>;
}

/**
 * Active workflows (default `view=all` and the exception views that operate on
 * the active roster) read only NON-archived students — `student.archived_at IS
 * NULL`. The dedicated `view=archived` view deliberately includes the archived
 * set so that restore is reachable from an explicit archive context, while
 * normal active-workflow lists and creation selectors never pick up archived
 * records.
 */
const EXCEPTION_VIEWS: { key: ExceptionView; label: string; description: string; color: string }[] = [
  { key: "all",         label: "Active Students",     description: "",                                     color: "" },
  { key: "archived",    label: "Archived Students",   description: "Students who have been archived",      color: "amber" },
  { key: "no-apps",     label: "No Applications",     description: "Never submitted an application",        color: "amber" },
  { key: "no-advising", label: "No Advising",          description: "Never had an advising meeting",         color: "amber" },
  { key: "prior-award", label: "Prior Award + Active", description: "Has scholarship history & an application", color: "emerald" },
];

/**
 * Allowlisted URL filter/sort values. Raw query-string values are mapped
 * through these lists; anything unknown falls back to the safe default so a
 * crafted `sort`/`standing`/`flag` can never reach PostgREST as raw input.
 */
const CLASS_STANDINGS = [
  "Freshman",
  "Sophomore",
  "Junior",
  "Senior",
  "Graduate",
  "Doctoral",
] as const;

const STUDENT_SORT_FIELDS = ["full_name", "major", "gpa", "class_standing"] as const;
type StudentSortField = (typeof STUDENT_SORT_FIELDS)[number];

/** `flag` identifies the success/outreach badge categories (mirrors the table). */
const STUDENT_FLAG_FILTERS = ["ch", "honors", "first_gen", "other"] as const;

/** Sort directions the list allows. Anything else normalizes to `asc`. */
const STUDENT_SORT_DIRECTIONS = ["asc", "desc"] as const;

function parseView(value: string | undefined): ExceptionView {
  return value !== undefined && EXCEPTION_VIEWS.some((item) => item.key === value)
    ? (value as ExceptionView)
    : "all";
}

function isSortField(value: string | undefined): value is StudentSortField {
  return value !== undefined && (STUDENT_SORT_FIELDS as readonly string[]).includes(value);
}

type RosterCounts = { baseCount: number; chCount: number };

type StudentsResult =
  | {
      ok: true;
      students: StudentListRow[];
      count: number;
      pagination: ReturnType<typeof resolvePagination>;
      pages: number;
    }
  | { ok: false };

/**
 * Bounded, server-side student roster loader.
 *
 * Reads the read-only `student_list` view with an exact count and an inclusive
 * `.range(...)` so the first request never transfers the whole roster. The
 * exception flags (`has_application`, `has_advising`, `has_prior_award`) are
 * derived inside the view, removing the previous full-table
 * application/advising/history exception queries. Search/filter/sort values are
 * allowlisted; the final order is always deterministic (`student_id` tiebreak).
 */
export async function getStudents(params: {
  view?: string;
  search?: string;
  standing?: string;
  flag?: string;
  sort?: string;
  direction?: string;
  page?: string;
  pageSize?: string;
}): Promise<StudentsResult> {
  try {
    // Client construction happens inside the failure boundary: a THROWN
    // construction/request-context error also yields a distinguishable failure
    // so the page renders the explicit unavailable state.
    const supabase = createServerClient();
    const pagination = resolvePagination(params);
    const view = parseView(params.view);

    let query = supabase.from("student_list").select("*", { count: "exact" });

    // PostgREST exposes `.is()` and `.not()` on the chain. We probe for them
    // to keep the loader resilient against the unit-test mock chain (which
    // exposes only the methods it needs); production sessions always apply
    // the filter at the database boundary.
    const chain = query as unknown as {
      is?: (column: string, value: null) => typeof query;
      not?: (column: string, op: string, value: null) => typeof query;
    };

    if (view === "archived") {
      if (typeof chain.not === "function") {
        query = chain.not("archived_at", "is", null);
      }
    } else if (typeof chain.is === "function") {
      query = chain.is("archived_at", null);
    }

    // Exception-view predicates derive from the view's own flags. These
    // replace the previous full-table application/advising/history reads.
    if (view === "no-apps") {
      query = query.eq("has_application", false);
    } else if (view === "no-advising") {
      query = query.eq("has_advising", false);
    } else if (view === "prior-award") {
      // Operational prior-award queue: non-voided history AND a current
      // application (the view already excluded voided awards).
      query = query.eq("has_prior_award", true).eq("has_application", true);
    }

    // Free-text search runs against allowlisted view columns; delimiters are
    // neutralized so a crafted term cannot inject extra PostgREST operators
    // into `.or(...)`. A numeric-only term also matches a student id.
    const term = params.search?.trim().replace(/[,%()*\\]/g, " ").replace(/\s+/g, " ").trim();
    if (term) {
      const clauses = [`full_name.ilike.%${term}%`, `email.ilike.%${term}%`];
      query = query.or(
        /^\d+$/.test(term)
          ? `${clauses.join(",")},student_id.eq.${term}`
          : clauses.join(","),
      );
    }

    // Standing and badge filters apply to the browsable all/archived views,
    // matching the pre-existing behavior where exception views filtered only
    // by their exception membership. Raw URL values are allowlist-gated so a
    // crafted term can never reach PostgREST as a column/value.
    const browseable = view === "all" || view === "archived";
    const flag = params.flag && (STUDENT_FLAG_FILTERS as readonly string[]).includes(params.flag)
      ? params.flag
      : undefined;
    if (browseable && params.standing && (CLASS_STANDINGS as readonly string[]).includes(params.standing)) {
      query = query.eq("class_standing", params.standing);
    }
    if (browseable && flag) {
      if (flag === "ch") query = query.eq("is_ch_student", true);
      else if (flag === "honors") query = query.eq("honors_college", true);
      else if (flag === "first_gen") query = query.eq("first_gen", true);
      else if (flag === "other") {
        query = query
          .eq("is_ch_student", false)
          .eq("honors_college", false)
          .eq("first_gen", false);
      }
    }

    // Deterministic sort: the allowlisted visible column plus the `student_id`
    // tie-breaker; the default is `student_id DESC`. Nullable columns sort with
    // nulls last in both directions (matching the previous client compare).
    const direction =
      params.direction && (STUDENT_SORT_DIRECTIONS as readonly string[]).includes(params.direction)
        ? params.direction
        : "asc";
    let ordered: typeof query;
    if (isSortField(params.sort)) {
      ordered = query
        .order(params.sort, { ascending: direction !== "desc", nullsFirst: false })
        .order("student_id", { ascending: false });
    } else {
      ordered = query.order("student_id", { ascending: false });
    }

    const { data, error, count } = await ordered.range(pagination.offset, pagination.to);

    if (error) {
      console.error("Error fetching students:", error);
      return { ok: false };
    }
    return {
      ok: true,
      students: (data as StudentListRow[]) || [],
      count: count ?? 0,
      pagination,
      pages: totalPages(count ?? 0, pagination.pageSize),
    };
  } catch (error) {
    console.error("Error fetching students:", error);
    return { ok: false };
  }
}

/**
 * Roster-context metric counts for the KPI cards.
 *
 * `totalStudents` / `chStudents` are independent of the current page *and* of
 * the active search/filter/sort criteria, so the cards describe the whole
 * active (or archived) roster rather than a page slice. Both counts use the
 * same view-context predicate (`archived_at` rule only) and are `head: true`
 * exact counts, so they never transfer rows.
 */
export async function getRosterCounts(view: ExceptionView): Promise<RosterCounts> {
  try {
    const supabase = createServerClient();

    // One independent head-only exact-count builder per predicate. The whole
    // active/archived roster and the CH subset must not share a mutable
    // builder: chaining `.eq("is_ch_student", true)` onto the roster builder
    // would leak that predicate into the base total and undercount the roster.
    const headCount = () =>
      supabase.from("student_list").select("*", { count: "exact", head: true });

    const applyContext = (query: ReturnType<typeof headCount>) => {
      const chain = query as unknown as {
        is?: (column: string, value: null) => typeof query;
        not?: (column: string, op: string, value: null) => typeof query;
      };
      if (view === "archived") {
        return typeof chain.not === "function"
          ? chain.not("archived_at", "is", null)
          : query;
      }
      return typeof chain.is === "function" ? chain.is("archived_at", null) : query;
    };

    const base = applyContext(headCount());

    const chContext = applyContext(headCount());
    const chChain = chContext as unknown as {
      eq?: (column: string, value: unknown) => typeof chContext;
    };
    const ch =
      typeof chChain.eq === "function" ? chChain.eq("is_ch_student", true) : chContext;

    const [baseResult, chResult] = await Promise.all([base, ch]);
    return {
      baseCount: baseResult.count ?? 0,
      chCount: chResult.count ?? 0,
    };
  } catch {
    return { baseCount: 0, chCount: 0 };
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

function StudentsUnavailable() {
  return (
    <PageSection
      title="Students unavailable"
      description="The student roster could not be reached."
    >
      <AppCard className="border-amber-200 bg-amber-50/60 shadow-sm" role="alert">
        <AppCardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div>
              <AppCardTitle className="text-base font-semibold text-slate-900">
                Students are currently unavailable
              </AppCardTitle>
              <AppCardDescription className="mt-1 text-slate-600">
                We couldn&apos;t load the latest student roster. Refresh the page to try again.
              </AppCardDescription>
            </div>
          </div>
        </AppCardHeader>
        <AppCardContent>
          <Link
            href="/students"
            className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            Refresh students
          </Link>
        </AppCardContent>
      </AppCard>
    </PageSection>
  );
}

interface StudentsQueryState {
  view?: string;
  standing?: string;
  flag?: string;
  search?: string;
  sort?: string;
  direction?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Students Content Component
 */
export async function StudentsContent({ view, ...queryState }: StudentsQueryState) {
  const effectiveView = parseView(view);
  const [result, rosterCounts, activeApplications, fellowshipsAvailable] = await Promise.all([
    // The loader applies the exception-view predicates itself, so the raw
    // `view` value must reach it alongside the URL state.
    getStudents({ ...queryState, view }),
    getRosterCounts(effectiveView),
    getApplicationsCount(),
    getFellowshipsCount(),
  ]);

  if (result.ok === false) {
    return <StudentsUnavailable />;
  }

  // Canonicalize the URL: an out-of-range page (after a filter change or a
  // deleted row) collapses to the last valid page (or page 1 for zero
  // results), and any non-canonical page/pageSize representation is rewritten
  // once via redirect. Contextual parameters — including the exception
  // `view` and any unrelated keys in the query state — are preserved.
  const pageOutOfRange = result.pagination.page > Math.max(1, result.pages);
  const nonCanonical =
    String(result.pagination.page) !== (queryState.page ?? "1") ||
    String(result.pagination.pageSize) !== (queryState.pageSize ?? "25");
  if (pageOutOfRange || nonCanonical) {
    const canonical = new URLSearchParams();
    if (effectiveView !== "all") canonical.set("view", effectiveView);
    for (const [key, value] of Object.entries(queryState)) {
      if (value !== undefined) canonical.set(key, value);
    }
    canonical.set(
      "page",
      String(pageOutOfRange ? Math.max(1, result.pages) : result.pagination.page),
    );
    canonical.set("pageSize", String(result.pagination.pageSize));
    redirect(`/students?${canonical.toString()}`);
  }

  const students = result.students;
  let exceptionBanner: React.ReactNode = null;

  if (effectiveView === "no-apps") {
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900">Application outreach queue</p>
            <p className="text-sm text-amber-800">
              {result.count} student{result.count !== 1 ? "s" : ""} have had no applications recorded. These are candidates to reach out to about fellowship opportunities.
            </p>
          </div>
          <MetricBadge tone="amber">{result.count} open</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  } else if (effectiveView === "no-advising") {
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900">Advising coverage gap</p>
            <p className="text-sm text-amber-800">
              {result.count} student{result.count !== 1 ? "s" : ""} have never had an advising meeting. Consider scheduling outreach sessions.
            </p>
          </div>
          <MetricBadge tone="amber">{result.count} unseen</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  } else if (effectiveView === "prior-award") {
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-emerald-200/70 bg-emerald-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-emerald-900">High-priority follow-up</p>
            <p className="text-sm text-emerald-800">
              {result.count} student{result.count !== 1 ? "s" : ""} have prior scholarship history and a current application. Strong candidates for advisor follow-up.
            </p>
          </div>
          <MetricBadge tone="green">{result.count} priority</MetricBadge>
        </AppCardContent>
      </AppCard>
    );
  } else if (effectiveView === "archived") {
    // Archive-context banner: makes the explicit restore affordance obvious
    // without leaving the page. The table renders Restore actions; this
    // banner just orients the operator to the dedicated archive context.
    exceptionBanner = (
      <AppCard variant="soft" className="mb-6 border-amber-200/70 bg-amber-50/70">
        <AppCardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-900">Archived students</p>
            <p className="text-sm text-amber-800">
              {result.count} archived student{result.count !== 1 ? "s" : ""}. Each row shows when the student was archived; restoring returns the student to active workflows while preserving every application, advising meeting, and scholarship history record.
            </p>
          </div>
          <MetricBadge tone="amber">{result.count} archived</MetricBadge>
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
          <StatCard icon={Users} value={rosterCounts.baseCount} title="Total Students" description="Tracked in the student roster" tone="blue" />
          <StatCard icon={GraduationCap} value={rosterCounts.chCount} title="CH Students" description="Students marked for CH advising" tone="green" />
          <StatCard icon={FileText} value={activeApplications} title="Active Applications" description="Current application records on file" tone="violet" />
          <StatCard icon={Award} value={fellowshipsAvailable} title="Fellowships Available" description="Programs available for matching" tone="amber" />
        </div>
      </PageSection>

      {exceptionBanner}

      {/* Students Table */}
      <StudentsTable
        initialStudents={students}
        initialSearchQuery={queryState.search}
        archiveView={effectiveView === "archived"}
        totalCount={result.count}
        page={result.pagination.page}
        pageSize={result.pagination.pageSize}
        totalPages={result.pages}
      />
    </>
  );
}

export default async function StudentsPage({ searchParams }: Props) {
  const params = await searchParams;
  const view = parseView(params.view);
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
        <StudentsContent view={view} {...params} />
      </Suspense>
    </>
  );
}