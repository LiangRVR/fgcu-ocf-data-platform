import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { ScholarshipHistoryTable } from "@/components/scholarship-history/scholarship-history-table";
import type { Database } from "@/types/database";
import { BookOpen, Trophy, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { DEFAULT_PAGE_SIZE, resolvePagination, totalPages } from "@/lib/utils/pagination";

export const metadata: Metadata = { title: "Scholarship History" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    fellowship_id?: string;
    search?: string; filter?: string; page?: string; pageSize?: string;
  }>;
}

type ScholarshipHistoryListRow = Database["public"]["Views"]["scholarship_history_list"]["Row"];

type ScholarshipHistoryAmendment =
  Database["public"]["Tables"]["scholarship_history_amendment"]["Row"] & {
    fellowship: { fellowship_name: string } | null;
  };

export type ScholarshipHistory = ScholarshipHistoryListRow & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
  effective: ScholarshipHistoryListRow;
  amendments: ScholarshipHistoryAmendment[];
};

/** URL/query state accepted by the Scholarship History list loader. */
export interface ScholarshipHistoryQuery {
  search?: string;
  fellowship_id?: string;
  filter?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Independently-derived operational (non-void) metrics.
 *
 * These are never derived from the current page slice: `records` is an exact
 * count over the whole filtered relation and `students` is the distinct-student
 * count over the same non-void rows, so pagination can never change a displayed
 * total.
 */
export interface ScholarshipHistoryOperationalSummary {
  records: number;
  students: number;
  repeatAwards: number;
}

export interface ScholarshipHistoryResult {
  records: ScholarshipHistory[];
  /** Exact filtered list count (voided awards included) for pagination. */
  count: number;
  /** Independent non-void summary for the operational surfaces. */
  summary: ScholarshipHistoryOperationalSummary;
  pagination: ReturnType<typeof resolvePagination>;
  pages: number;
  error: Error | null;
}

const EMPTY_SUMMARY: ScholarshipHistoryOperationalSummary = {
  records: 0,
  students: 0,
  repeatAwards: 0,
};

/** Normalize the (legacy `filter`-compatible) fellowship selector value. */
export function normalizeFellowshipFilter(
  params: Pick<ScholarshipHistoryQuery, "fellowship_id" | "filter">,
): string | null {
  const raw = params.fellowship_id ?? params.filter;
  if (!raw || raw === "all") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

/**
 * Scholarship History audit reader.
 *
 * Reads the shared `scholarship_history_list` SECURITY INVOKER view so the
 * corrected award program is displayed (never the immutable base value) and the
 * authoritative `is_voided` state is available for the audit surface. This page
 * deliberately retains voided awards so their audit trail stays visible, while
 * the operational summary excludes them independently of the current page.
 *
 * The view carries no PostgREST relationship to `student`/`fellowship`, but it
 * flattens `student_name`/`fellowship_name`, so no scoped name lookups are
 * needed. Amendment trails are loaded in one bounded query for this page's IDs.
 */
export async function getScholarshipHistory(
  params: ScholarshipHistoryQuery = {},
): Promise<ScholarshipHistoryResult> {
  const supabase = createServerClient();
  const pagination = resolvePagination(params);
  try {
    const search = params.search?.trim() ?? "";
    const searchPattern = search ? `%${search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const fellowship = normalizeFellowshipFilter(params);

    // Independently-derived non-void metrics (search/fellowship scoped). The
    // SECURITY INVOKER aggregate returns the exact non-void total and the
    // distinct-student count for the WHOLE filtered relation in one database
    // round trip, so pagination can never change a displayed total and no rows
    // are transferred to the application for the summary.
    let summary = EMPTY_SUMMARY;
    const { data: operationalRows, error: operationalError } = await supabase.rpc(
      "scholarship_history_operational_summary",
      {
        p_search: searchPattern,
        p_fellowship_id: fellowship ? Number(fellowship) : null,
      },
    );
    if (operationalError) {
      console.error("Error fetching scholarship history metrics:", operationalError);
    } else {
      const operational = Array.isArray(operationalRows) ? operationalRows[0] : operationalRows;
      const records = Number(operational?.total_records ?? 0);
      const students = Number(operational?.distinct_students ?? 0);
      summary = { records, students, repeatAwards: Math.max(0, records - students) };
    }

    // Bounded page of matching rows: exact count, stable `history_id DESC`.
    let listQuery = supabase
      .from("scholarship_history_list")
      .select("*", { count: "exact" });
    if (searchPattern) listQuery = listQuery.ilike("student_name", searchPattern);
    if (fellowship) listQuery = listQuery.eq("fellowship_id", Number(fellowship));
    const { data, error, count } = await listQuery
      .order("history_id", { ascending: false })
      .range(pagination.offset, pagination.to);
    if (error) {
      console.error("Error fetching scholarship history:", error);
      return {
        records: [],
        count: 0,
        summary,
        pagination,
        pages: 0,
        error: error as Error,
      };
    }

    const records = (data as ScholarshipHistoryListRow[] | null) ?? [];
    const pages = totalPages(count ?? 0, pagination.pageSize);
    if (pages > 0 && pagination.page > pages) {
      // Out of range: the page canonicalizes to the last valid page.
      return { records: [], count: count ?? 0, summary, pagination, pages, error: null };
    }

    // Bounded audit/amendment query for exactly the IDs on this page.
    const ids = records.map((record) => record.history_id);
    const trails: Record<number, ScholarshipHistoryAmendment[]> = {};
    if (ids.length) {
      const { data: amendments, error: amendmentError } = await supabase
        .from("scholarship_history_amendment")
        .select(
          "*, fellowship:fellowship!scholarship_history_amendment_corrected_fellowship_id_fkey(fellowship_name)",
        )
        .in("history_id", ids)
        .order("created_at", { ascending: true })
        .order("amendment_id", { ascending: true });
      if (amendmentError) {
        console.error("Error fetching scholarship history amendments:", amendmentError);
      } else {
        for (const amendment of (amendments ?? []) as ScholarshipHistoryAmendment[]) {
          (trails[amendment.history_id] ??= []).push(amendment);
        }
      }
    }

    return {
      records: records.map((record) => ({
        ...record,
        effective: record,
        student: { full_name: record.student_name },
        fellowship: { fellowship_name: record.fellowship_name },
        amendments: trails[record.history_id] ?? [],
      })),
      count: count ?? 0,
      summary,
      pagination,
      pages,
      error: null,
    };
  } catch (cause) {
    return {
      records: [],
      count: 0,
      summary: EMPTY_SUMMARY,
      pagination,
      pages: 0,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }
}

/**
 * Active-students selector for the scholarship-history form. Excludes
 * archived students server-side.
 */
/**
 * Pure operational award summary for a fully-loaded set of history records.
 * Voided awards stay on the audit surface (and remain listed) but are excluded
 * from the operational totals, so a void never inflates the recorded-award
 * counts. Paginated callers must use the loader's independently-derived
 * `summary` instead of this page slice.
 */
export function summarizeOperationalAwards(records: ScholarshipHistory[]): {
  records: number;
  students: number;
  repeatAwards: number;
} {
  const operational = records.filter((record) => !record.is_voided);
  const students = new Set(operational.map((record) => record.student_id)).size;
  return {
    records: operational.length,
    students,
    repeatAwards: operational.length - students,
  };
}

export default async function ScholarshipHistoryPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;
  const defaultFellowshipId = params.fellowship_id;

  const result = await getScholarshipHistory(params);

  // Canonicalize URL state: normalize page/pageSize/search/fellowship, drop
  // defaults and invalid values, and resolve an out-of-range page to the last
  // valid page (or page 1 for zero results). Contextual `add`/`student_id`
  // parameters survive canonicalization so the creation flow is never lost.
  const resolvedPage = result.pages > 0 ? Math.min(result.pagination.page, result.pages) : 1;
  const search = params.search?.trim() ?? "";
  const fellowship = normalizeFellowshipFilter(params);
  const supplied = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "fellowship_id", "filter"] as const) {
    const value = params[key];
    if (value !== undefined && value !== "") supplied.set(key, value);
  }
  const canonical = new URLSearchParams();
  if (resolvedPage > 1) canonical.set("page", String(resolvedPage));
  if (result.pagination.pageSize !== DEFAULT_PAGE_SIZE) {
    canonical.set("pageSize", String(result.pagination.pageSize));
  }
  if (search) canonical.set("search", search);
  if (fellowship) canonical.set("fellowship_id", fellowship);
  if (supplied.toString() !== canonical.toString()) {
    if (params.add) canonical.set("add", params.add);
    if (params.student_id) canonical.set("student_id", params.student_id);
    redirect(canonical.size ? `/scholarship-history?${canonical}` : "/scholarship-history");
  }

  const { records, summary } = result;
  const { records: awardCount, students: uniqueStudents, repeatAwards } = summary;

  return (
    <>
      <PageHeader
        eyebrow="Award History"
        title="Scholarship History"
        description="Record prior awards and preserve historical context for students with new fellowship activity."
      >
        <MetricBadge tone="blue">{awardCount} records</MetricBadge>
        <MetricBadge tone="green">{uniqueStudents} students</MetricBadge>
      </PageHeader>

      <PageSection
        title="Historical Coverage"
        description="Preserve award history as advising context and track how widely prior fellowship outcomes are represented across students and programs."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={BookOpen} value={awardCount} title="Award Records" description="Historical award outcomes on file" tone="blue" />
          <StatCard icon={Users} value={uniqueStudents} title="Students With History" description="Students connected to prior awards" tone="green" />
          <StatCard icon={Trophy} value={repeatAwards} title="Repeat Awards" description="Additional awards beyond each student's first recorded history item" tone="violet" />
        </div>
      </PageSection>

      <ScholarshipHistoryTable
        initialRecords={records}
        totalCount={result.count}
        totalPages={result.pages}
        currentPage={resolvedPage}
        currentPageSize={result.pagination.pageSize}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultFellowshipId={defaultFellowshipId}
      />
    </>
  );
}
