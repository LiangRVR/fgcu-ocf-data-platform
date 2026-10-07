import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { requireAdvisor } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { AdvisingTable } from "@/components/advising/advising-table";
import type { Database } from "@/types/database";
import Link from "next/link";
import { CalendarCheck2, ShieldAlert, UserRoundCheck, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";

export const metadata: Metadata = { title: "Advising" };

interface Props {
  searchParams: Promise<{
    add?: string;
    student_id?: string;
    advisor_id?: string;
    no_show?: string;
    page?: string;
    pageSize?: string;
    search?: string;
    mode?: string;
  }>;
}

type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { full_name: string } | null;
  advisor: { advisor_name: string } | null;
  recorded_by: { advisor_name: string } | null;
  application_id: number | null;
  application: {
    application_id: number;
    application_year: number | null;
    fellowship_id: number;
    fellowship: { fellowship_name: string } | null;
  } | null;
  amendments: (Database["public"]["Tables"]["advising_meeting_amendment"]["Row"] & {
    created_by: { advisor_name: string } | null;
  })[];
};

type AdvisingMeetingsResult = {
  meetings: AdvisingMeeting[];
  count: number;
  pagination: ReturnType<typeof resolvePagination>;
  pages: number;
};

/**
 * Bounded, server-side advising list loader.
 *
 * Reads the read-only `advising_meeting_list` view (flattened student/advisor/
 * recorder/application/fellowship context) with an exact count and an inclusive
 * `.range(...)`. Free-text search is an allowlisted PostgREST `.or` over actual
 * view columns — never a raw column/operator from the query string, and never
 * the non-existent `search_document` field. Amendments are loaded in a second,
 * bounded query for just the meeting IDs on this page so history stays
 * chronological without loading the whole amendment table.
 */
async function getAdvisingMeetings(params: {
  page?: string;
  pageSize?: string;
  search?: string;
  mode?: string;
  no_show?: string;
  advisor_id?: string;
}): Promise<AdvisingMeetingsResult> {
  const supabase = createServerClient();
  const pagination = resolvePagination(params);
  try {
    let query = supabase
      .from("advising_meeting_list")
      .select("*", { count: "exact" });

    // Allowlisted search: only view columns, delimiters neutralized so a
    // crafted term cannot inject extra PostgREST operators into `.or(...)`.
    const term = params.search?.trim().replace(/[,%()*\\]/g, " ").replace(/\s+/g, " ").trim();
    if (term) {
      const clauses = [
        `student_name.ilike.*${term}*`,
        `advisor_name.ilike.*${term}*`,
        `notes.ilike.*${term}*`,
        `meeting_mode.ilike.*${term}*`,
        `fellowship_name.ilike.*${term}*`,
      ];
      query = query.or(
        /^\d{4}$/.test(term)
          ? `${clauses.join(",")},application_year.eq.${term}`
          : clauses.join(","),
      );
    }
    if (params.mode === "In-Person" || params.mode === "Virtual") {
      query = query.eq("meeting_mode", params.mode);
    }
    if (params.no_show === "yes") query = query.eq("no_show", true);
    if (params.no_show === "no") query = query.eq("no_show", false);
    if (params.advisor_id && /^\d+$/.test(params.advisor_id)) {
      query = query.eq("advisor_id", Number(params.advisor_id));
    }

    const { data, error, count } = await query
      .order("meeting_date", { ascending: false })
      .order("meeting_id", { ascending: false })
      .range(pagination.offset, pagination.to);
    if (error) {
      console.error("Error fetching advising meetings:", error);
      return { meetings: [], count: 0, pagination, pages: 0 };
    }

    const rows =
      (data as Database["public"]["Views"]["advising_meeting_list"]["Row"][] | null) ?? [];
    const ids = rows.map((row) => row.meeting_id);

    type AmendmentRow = Database["public"]["Tables"]["advising_meeting_amendment"]["Row"] & {
      created_by: { advisor_name: string } | null;
    };
    let amendments: AmendmentRow[] = [];
    if (ids.length) {
      const { data: amendmentRows, error: amendmentError } = await supabase
        .from("advising_meeting_amendment")
        .select(
          "amendment_id, meeting_id, reason, details, created_at, created_by_advisor_id, created_by:advisor!advising_meeting_amendment_created_by_advisor_id_fkey(advisor_name)",
        )
        .in("meeting_id", ids)
        .order("created_at", { ascending: true })
        .order("amendment_id", { ascending: true });
      if (amendmentError) {
        console.error("Error fetching advising amendments:", amendmentError);
      }
      amendments = ((amendmentRows as AmendmentRow[] | null) ?? [])
        .slice()
        .sort(
          (a, b) =>
            a.created_at.localeCompare(b.created_at) || a.amendment_id - b.amendment_id,
        );
    }
    const amendmentsByMeeting = new Map<number, AmendmentRow[]>();
    for (const amendment of amendments) {
      const list = amendmentsByMeeting.get(amendment.meeting_id) ?? [];
      list.push(amendment);
      amendmentsByMeeting.set(amendment.meeting_id, list);
    }

    const meetings: AdvisingMeeting[] = rows.map((row) => ({
      ...row,
      student: row.student_name ? { full_name: row.student_name } : null,
      advisor: row.advisor_name ? { advisor_name: row.advisor_name } : null,
      recorded_by: row.recorded_by_advisor_name
        ? { advisor_name: row.recorded_by_advisor_name }
        : null,
      application_id: row.application_id,
      application:
        row.application_id == null
          ? null
          : {
              application_id: row.application_id,
              application_year: row.application_year,
              fellowship_id: row.fellowship_id ?? 0,
              fellowship: row.fellowship_name
                ? { fellowship_name: row.fellowship_name }
                : null,
            },
      amendments: amendmentsByMeeting.get(row.meeting_id) ?? [],
    }));

    return {
      meetings,
      count: count ?? 0,
      pagination,
      pages: totalPages(count ?? 0, pagination.pageSize),
    };
  } catch {
    return { meetings: [], count: 0, pagination, pages: 0 };
  }
}

export default async function AdvisingPage({ searchParams }: Props) {
  const advisor = await requireAdvisor();
  const params = await searchParams;
  const autoOpenAdd       = params.add     === "1";
  const defaultStudentId  = params.student_id;
  const defaultAdvisorId  = params.advisor_id ?? String(advisor.advisor_id);
  const initialNoShowFilter =
    params.no_show === "yes" ? "yes" : params.no_show === "no" ? "no" : undefined;

  const result = await getAdvisingMeetings(params);
  // Canonicalize the URL: an out-of-range page (after a filter change or a
  // deleted row) collapses to the last valid page, and any non-canonical
  // page/pageSize representation is rewritten once via redirect.
  const pageOutOfRange = result.pagination.page > Math.max(1, result.pages);
  const nonCanonical =
    String(result.pagination.page) !== (params.page ?? "1") ||
    String(result.pagination.pageSize) !== (params.pageSize ?? "25");
  if (pageOutOfRange || nonCanonical) {
    const canonical = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) canonical.set(key, value);
    }
    canonical.set(
      "page",
      String(pageOutOfRange ? Math.max(1, result.pages) : result.pagination.page),
    );
    canonical.set("pageSize", String(result.pagination.pageSize));
    redirect(`/advising?${canonical.toString()}`);
  }
  const meetings = result.meetings;

  // Compute exception counts for pill bar labels
  const noShowCount = meetings.filter((m) => m.no_show).length;
  const studentIdsWithMeetings = new Set(meetings.map((m) => m.student_id));
  const advisorCoverage = new Set(meetings.map((m) => m.advisor_id).filter((advisorId): advisorId is number => advisorId !== null)).size;

  const isNoShow = params.no_show === "yes";

  return (
    <>
      <PageHeader
        eyebrow="Advisor Activity"
        title="Advising"
        description="Track advising sessions, attendance risk, and students who still need advisor contact."
      >
        <MetricBadge tone="blue">{result.count} meetings</MetricBadge>
        <MetricBadge tone="red">{noShowCount} no-shows</MetricBadge>
        <MetricBadge tone="amber">{studentIdsWithMeetings.size} students on this page</MetricBadge>
      </PageHeader>

      <PageSection
        title="Advising Coverage"
        description="Use these metrics to identify attendance risk, advisor load, and which students still need first contact."
        className="mb-6"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={CalendarCheck2} value={meetings.length} title="Meetings on this page" description="Advising sessions on this page" tone="blue" />
          <StatCard icon={ShieldAlert} value={noShowCount} title="No-shows on this page" description="Meetings where the student did not attend on this page" tone="rose" />
          <StatCard icon={Users} value={studentIdsWithMeetings.size} title="Students on this page" description="Students represented on this page" tone="amber" />
          <StatCard icon={UserRoundCheck} value={advisorCoverage} title="Advisors on this page" description="Advisors represented in meetings on this page" tone="green" />
        </div>
      </PageSection>

      {/* Exception view pill bar */}
      <div className="mb-8 flex flex-wrap gap-2">
        <Link
          href="/advising"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${
            !isNoShow
              ? "border-slate-900 bg-slate-900 text-white shadow-sm"
              : "border-border bg-white/80 text-slate-600 hover:border-slate-400 hover:bg-white"
          }`}
        >
          All Meetings
        </Link>
        <Link
          href="/advising?no_show=yes"
          className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium motion-safe:transition-colors ${
            isNoShow
              ? "border-red-600 bg-red-600 text-white shadow-sm"
              : "border-red-200 bg-red-50/80 text-red-700 hover:border-red-400 hover:bg-red-50"
          }`}
        >
          No-Shows
          {!isNoShow && noShowCount > 0 && (
            <span className="ml-1.5 tabular-nums">({noShowCount})</span>
          )}
        </Link>
        <Link
          href="/students?view=no-advising"
          className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50/80 px-3 py-1.5 text-xs font-medium text-amber-700 motion-safe:transition-colors hover:border-amber-400 hover:bg-amber-50"
        >
          Students Never Seen
        </Link>
      </div>

      {isNoShow && (
        <AppCard variant="soft" className="mb-6 border-red-200/70 bg-red-50/70">
          <AppCardContent className="flex flex-col gap-2 p-4 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between">
            <p>Showing only meetings where the student did not attend.</p>
            <Link href="/advising" className="font-medium underline underline-offset-4 hover:text-red-600">Clear filter</Link>
          </AppCardContent>
        </AppCard>
      )}

      <AdvisingTable
        initialMeetings={meetings}
        currentAdvisorId={advisor.advisor_id}
        autoOpenAdd={autoOpenAdd}
        defaultStudentId={defaultStudentId}
        defaultAdvisorId={defaultAdvisorId}
        initialNoShowFilter={initialNoShowFilter}
        initialModeFilter={params.mode}
        initialSearchQuery={params.search}
        page={result.pagination.page}
        pageSize={result.pagination.pageSize}
        totalCount={result.count}
        totalPages={result.pages}
      />
    </>
  );
}
