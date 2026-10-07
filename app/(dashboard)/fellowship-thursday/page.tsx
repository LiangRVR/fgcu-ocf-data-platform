import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import { FellowshipThursdayTable } from "@/components/fellowship-thursday/fellowship-thursday-table";
import type { Database } from "@/types/database";
import { CalendarDays, CircleCheckBig, Tags, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";

export const metadata: Metadata = { title: "Fellowship Thursday" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    search?: string; source?: string; attended?: string; page?: string; pageSize?: string;
  }>;
}

type EffectiveFellowshipThursday = Database["public"]["Views"]["fellowship_thursday_list"]["Row"];

type FellowshipThursday = EffectiveFellowshipThursday & {
  student: { full_name: string } | null;
};

/**
 * Operational Fellowship Thursday reader.
 *
 * Reads the flattened `fellowship_thursday_list` SECURITY INVOKER view, which is
 * backed by the shared `effective_fellowship_thursday` view, so the page and
 * table consume the newest applicable correction per field while the immutable
 * base rows and the amendment audit trail remain readable through their own
 * surfaces. Corrections are never extra attendance rows: the view exposes
 * exactly one row per attendance record, with the display name already
 * flattened as `student_name` (no row-multiplying join).
 *
 * Results are server-paginated with an exact count and an inclusive
 * `.range(offset, to)` bound, ordered by the stable `attendance_id`.
 */
export interface FellowshipThursdayRecordsResult {
  records: FellowshipThursday[];
  count: number;
  pagination: ReturnType<typeof resolvePagination>;
  pages: number;
  error: Error | null;
}

export async function getFellowshipThursdayRecords(params: { search?: string; source?: string; attended?: string; page?: string; pageSize?: string } = {}): Promise<FellowshipThursdayRecordsResult> {
  const supabase = createServerClient();
  try {
    const pagination = resolvePagination(params);
    let query = supabase.from("fellowship_thursday_list").select("*", { count: "exact" });
    if (params.search?.trim()) query = query.ilike("student_name", `%${params.search.trim()}%`);
    if (params.source && params.source !== "all") query = query.eq("source_info", params.source);
    if (params.attended === "yes") query = query.eq("attended", true);
    if (params.attended === "no") query = query.eq("attended", false);
    const { data, error, count } = await query.order("attendance_id", { ascending: false }).range(pagination.offset, pagination.to);
    if (error) {
      console.error("Error fetching fellowship thursday records:", error);
      return { records: [], count: 0, pagination, pages: 0, error: error as Error };
    }

    const records = (data as EffectiveFellowshipThursday[]) || [];
    const pages = totalPages(count ?? 0, pagination.pageSize);
    return { records: records.map((record) => ({ ...record, student: { full_name: record.student_name } })), count: count ?? 0, pagination, pages, error: null };
  } catch (cause) {
    return { records: [], count: 0, pagination: resolvePagination(params), pages: 0, error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

export default async function FellowshipThursdayPage({ searchParams }: Props) {
  const params = await searchParams;
  const autoOpenAdd = params.add === "1";
  const defaultStudentId = params.student_id;

  const result = await getFellowshipThursdayRecords(params);
  // Canonicalize the URL: clamp an out-of-range page to the last real page and
  // rewrite non-canonical page/pageSize values, preserving every other
  // contextual parameter (search/source/attended/add/student_id).
  const pageOutOfRange = result.pagination.page > Math.max(1, result.pages);
  const nonCanonical =
    String(result.pagination.page) !== (params.page ?? "1") ||
    String(result.pagination.pageSize) !== (params.pageSize ?? "25");
  if (pageOutOfRange || nonCanonical) {
    const canonical = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) canonical.set(key, value);
    }
    canonical.set("page", String(pageOutOfRange ? Math.max(1, result.pages) : result.pagination.page));
    canonical.set("pageSize", String(result.pagination.pageSize));
    redirect(`/fellowship-thursday?${canonical.toString()}`);
  }
  const records = result.records;
  const attendedCount = records.filter((record) => record.attended).length;
  const sourcedCount = records.filter((record) => Boolean(record.source_info)).length;
  const uniqueStudents = new Set(records.map((record) => record.student_id)).size;
  const missedCount = records.length - attendedCount;

  return (
    <>
      <PageHeader
        eyebrow="Event Outreach"
        title="Fellowship Thursday"
        description="Track weekly Fellowship Thursday attendance and monitor which students are entering through partner channels."
      >
        <MetricBadge tone="blue">{records.length} records</MetricBadge>
        <MetricBadge tone="green">{attendedCount} attended on this page</MetricBadge>
        <MetricBadge tone="amber">{sourcedCount} tagged sources</MetricBadge>
      </PageHeader>

      <PageSection
        title="Attendance Snapshot"
        description="Page-level snapshot for the records currently shown."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={CalendarDays} value={records.length} title="Attendance Records" description="Records on this page" tone="blue" />
          <StatCard icon={CircleCheckBig} value={attendedCount} title="Attended" description="Attendance on this page" tone="green" />
          <StatCard icon={Users} value={uniqueStudents} title="Unique Students on this page" description={`${missedCount} absence record${missedCount === 1 ? "" : "s"} on this page`} tone="violet" />
          <StatCard icon={Tags} value={sourcedCount} title="Tagged Sources" description="Records with outreach-source attribution on this page" tone="amber" />
        </div>
      </PageSection>

      <FellowshipThursdayTable
        initialRecords={records}
        totalCount={result.count}
        totalPages={result.pages}
        currentPage={result.pagination.page}
        currentPageSize={result.pagination.pageSize}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
      />
    </>
  );
}
