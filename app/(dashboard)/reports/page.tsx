import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import {
  AppCard as Card,
  AppCardContent as CardContent,
  AppCardDescription,
  AppCardHeader as CardHeader,
  AppCardTitle as CardTitle,
} from "@/components/ui/app-card";
import { MetricBadge } from "@/components/ui/metric-badge";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { createServerClient } from "@/lib/supabase/server";
import {
  computeReportMetrics,
  GENERAL_ADVISING_LABEL,
  type ReportApplicationRow,
  type ReportFellowshipThursdayRow,
  type ReportMeetingRow,
  type ReportMetrics,
  type ReportStudentRow,
} from "@/lib/reports/metrics";
import Link from "next/link";
import { AlertTriangle, Award, CalendarCheck, FileText, Users, UserRoundCheck } from "lucide-react";

export const metadata: Metadata = { title: "Reports" };

// ── helpers ──────────────────────────────────────────────────────────────────

function stageBadgeClass(stage: string): string {
  switch (stage) {
    case "Semi-Finalist": return "border-purple-200 bg-purple-100 text-purple-800";
    case "Finalist":      return "border-green-200 bg-green-100 text-green-800";
    case "Awarded":       return "border-emerald-200 bg-emerald-100 text-emerald-800 font-semibold";
    case "Rejected":      return "border-red-200 bg-red-100 text-red-700";
    case "Submitted":     return "border-blue-200 bg-blue-100 text-blue-800";
    case "Under Review":  return "border-yellow-200 bg-yellow-100 text-yellow-800";
    default:              return "border-gray-200 bg-gray-100 text-gray-700";
  }
}

function stageBarColor(stage: string): string {
  switch (stage) {
    case "Semi-Finalist": return "bg-purple-400";
    case "Finalist":      return "bg-green-500";
    case "Awarded":       return "bg-emerald-600";
    case "Rejected":      return "bg-red-400";
    case "Submitted":     return "bg-blue-400";
    case "Under Review":  return "bg-yellow-400";
    default:              return "bg-gray-300";
  }
}

function classBarColor(standing: string): string {
  switch (standing) {
    case "Freshman":  return "bg-sky-400";
    case "Sophomore": return "bg-indigo-400";
    case "Junior":    return "bg-violet-500";
    case "Senior":    return "bg-emerald-500";
    case "Graduate":  return "bg-amber-500";
    case "Doctoral":  return "bg-rose-500";
    default:          return "bg-gray-300";
  }
}

function formatMonth(yyyyMM: string): string {
  const [year, month] = yyyyMM.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

// ── data fetching ─────────────────────────────────────────────────────────────
//
// FULL-DATASET GUARD — Reports must never consume a paginated list page.
//
// Every query in `getReportsData` intentionally reads the COMPLETE authorized
// source set for its own aggregation:
//   * no `.range(...)`, no `.limit(...)`, and no `page`/`pageSize` state;
//   * no `count: "exact"` list contract — the metrics are computed in
//     `computeReportMetrics` from whole arrays, then rendered directly;
//   * no import or reuse of a list loader, `lib/utils/pagination`, or the
//     shared pagination component.
//
// RLS still scopes every row to the authenticated session (via the cookie-
// backed server client), so "complete" means complete within the caller's
// authorization — never an unauthenticated or service-role read. Making report
// input depend on a list page would silently produce page-dependent,
// incomplete totals; `tests/unit/app/(dashboard)/reports/page.test.ts` asserts
// the no-range/no-limit query shape and full-dataset completeness beyond a
// page size so a regression fails the unit lane.
//
// PERFORMANCE FOLLOW-UP (deliberately deferred, see
// `aidlc-docs/project/architecture.md`): if profiling later shows report
// transfer is a concern, introduce small `security_invoker` database
// aggregates incrementally with parity tests against the existing pure metric
// oracle in `lib/reports/metrics.ts`. Never paginate report inputs, and never
// introduce a service-role report path or materialized view.

type ReportsDataResult =
  | { ok: true; metrics: ReportMetrics }
  | { ok: false };

export async function getReportsData(): Promise<ReportsDataResult> {
  try {
    // Client construction happens inside the failure boundary: a THROWN
    // construction/request-context error also yields { ok: false } so the page
    // renders the explicit unavailable state.
    const supabase = createServerClient();
    // Full authorized source sets: no `.range`/`.limit`/count is applied here.
    const [
      applicationsRes,
      meetingsRes,
      studentsRes,
      ftRes,
    ] = await Promise.all([
      supabase
        .from("application")
        .select("student_id, fellowship_id, application_year, stage_of_application, is_finalist, is_semi_finalist, student(full_name, major, class_standing), fellowship(fellowship_name)"),
      supabase
        .from("advising_meeting")
        .select("student_id, application_id, advisor_id, no_show, meeting_date, advisor!advising_meeting_advisor_id_fkey(advisor_name), application!advising_meeting_application_id_fkey(application_id, application_year, fellowship_id, fellowship(fellowship_name))"),
      supabase
        .from("student")
        .select("student_id, full_name, major, class_standing"),
      // Operational Fellowship Thursday reads MUST consume the shared
      // effective view: a correction must change the operational attendance
      // totals and correction rows must never inflate the counts.
      supabase
        .from("effective_fellowship_thursday")
        .select("student_id, attended"),
    ]);

    if (applicationsRes.error || meetingsRes.error || studentsRes.error || ftRes.error) {
      return { ok: false };
    }

    const applications = (applicationsRes.data ?? []) as ReportApplicationRow[];
    const meetings     = (meetingsRes.data ?? [])      as ReportMeetingRow[];
    const students     = (studentsRes.data ?? [])      as ReportStudentRow[];
    const ftRows       = (ftRes.data ?? [])            as ReportFellowshipThursdayRow[];

    return { ok: true, metrics: computeReportMetrics(applications, meetings, students, ftRows) };
  } catch {
    return { ok: false };
  }
}

export function ReportsUnavailable() {
  return (
    <PageSection
      title="Reports unavailable"
      description="The reporting service could not be reached."
    >
      <Card className="border-amber-200 bg-amber-50/60 shadow-sm" role="alert">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" aria-hidden="true" />
            <div>
              <CardTitle className="text-base font-semibold text-slate-900">
                Reports are currently unavailable
              </CardTitle>
              <AppCardDescription className="mt-1 text-slate-600">
                We couldn&apos;t load the latest reporting data. Refresh the page to try again.
              </AppCardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <a
            href="/reports"
            className="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            Refresh reports
          </a>
        </CardContent>
      </Card>
    </PageSection>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function ReportsPage() {
  const result = await getReportsData();

  if (!result.ok) {
    return (
      <>
        <PageHeader
          eyebrow="Analytics"
          title="Reports"
          description="Cross-table insights for applications, advising, fellowships, and student engagement across the OCF workspace."
        />
        <div className="space-y-8">
          <ReportsUnavailable />
        </div>
      </>
    );
  }

  const data = result.metrics;

  const maxStage = Math.max(1, ...data.applicationsByStage.map((r) => r.count));
  const maxClass = Math.max(1, ...data.byClassStanding.map((r) => r.count));
  const maxNS    = Math.max(1, ...data.noShowTrend.map((r) => r.total));

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Reports"
        description="Cross-table insights for applications, advising, fellowships, and student engagement across the OCF workspace."
      >
        <MetricBadge tone="blue">Cross-table</MetricBadge>
        <MetricBadge tone="slate">Live metrics</MetricBadge>
      </PageHeader>

      <div className="space-y-8">

        {/* ── Summary stats ─────────────────────────────────────────────────── */}
        <PageSection
          title="System Totals"
          description="Top-line reporting metrics that frame the rest of the analytics surface."
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard title="Total Students" value={data.totals.students} description="Students on record" icon={Users} tone="blue" />
            <StatCard title="Applications" value={data.totals.applications} description="Tracked across all stages" icon={FileText} tone="violet" />
            <StatCard title="Advising Meetings" value={data.totals.meetings} description="Recorded advisor sessions" icon={CalendarCheck} tone="green" />
            <StatCard title="FT Attendees" value={data.totals.ftAttendees} description="Students with attendance history" icon={UserRoundCheck} tone="slate" />
            <StatCard title="Awards" value={data.totals.awarded} description="Applications marked awarded" icon={Award} tone="amber" />
          </div>
        </PageSection>

        <div className="grid gap-6 md:grid-cols-2">

          {/* R1: Applications by Stage */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Applications by Stage
              </CardTitle>
              <AppCardDescription>Pipeline from start to award</AppCardDescription>
            </CardHeader>
            <CardContent>
              {data.applicationsByStage.length === 0 ? (
                <p className="text-sm text-slate-400">No data yet.</p>
              ) : (
                <ul className="space-y-3">
                  {data.applicationsByStage.map(({ stage, count }) => (
                    <li key={stage}>
                      <div className="flex items-center justify-between mb-1">
                        <MetricBadge tone="slate" className={stageBadgeClass(stage)}>
                          {stage}
                        </MetricBadge>
                        <Link
                          href={`/applications?stage=${encodeURIComponent(stage)}`}
                          className="text-sm font-medium text-slate-700 tabular-nums hover:text-[#006747] hover:underline"
                        >
                          {count}
                        </Link>
                      </div>
                      <div className="h-2 w-full rounded-full bg-gray-100">
                        <div
                          className={`h-2 rounded-full ${stageBarColor(stage)}`}
                          style={{ width: `${Math.round((count / maxStage) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* R3: Students by Class Standing */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Students by Class Standing
              </CardTitle>
              <AppCardDescription>All enrolled students on record</AppCardDescription>
            </CardHeader>
            <CardContent>
              {data.byClassStanding.length === 0 ? (
                <p className="text-sm text-slate-400">No data yet.</p>
              ) : (
                <ul className="space-y-3">
                  {data.byClassStanding.map(({ standing, count }) => (
                    <li key={standing}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-slate-700">{standing}</span>
                        <span className="text-sm font-medium text-slate-700 tabular-nums">{count}</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-gray-100">
                        <div
                          className={`h-2 rounded-full ${classBarColor(standing)}`}
                          style={{ width: `${Math.round((count / maxClass) * 100)}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

        </div>

        {/* ── R2: Finalists & Awarded by Fellowship ─────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              Finalists &amp; Awarded Students by Fellowship &amp; Application Cycle
            </CardTitle>
            <AppCardDescription>
              How far applicants advance for each fellowship and application cycle
            </AppCardDescription>
          </CardHeader>
          <CardContent>
            {data.fellowshipsByFinalists.length === 0 ? (
              <p className="text-sm text-slate-400">No data yet.</p>
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {data.fellowshipsByFinalists.map(({ id, name, total, semiFinalists, finalists, awarded }) => (
                    <div key={`${id}:${name}`} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <Link
                          href={`/fellowships/${id}`}
                          className="min-w-0 text-sm font-semibold text-slate-800 hover:text-primary hover:underline"
                        >
                          <span className="line-clamp-2">{name}</span>
                        </Link>
                        <MetricBadge tone="slate">{total} apps</MetricBadge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricBadge tone="purple">{semiFinalists} semi</MetricBadge>
                        <MetricBadge tone="green">{finalists} finalists</MetricBadge>
                        <MetricBadge tone="amber">{awarded} awarded</MetricBadge>
                        <MetricBadge tone="slate">
                          {total > 0 ? `${Math.round((finalists / total) * 100)}% finalist rate` : "No rate yet"}
                        </MetricBadge>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-2 text-left font-medium text-slate-500">Fellowship</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Apps</th>
                      <th className="hidden pb-2 text-center font-medium text-slate-500 md:table-cell">Semi-Finalists</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Finalists</th>
                      <th className="hidden pb-2 text-center font-medium text-slate-500 sm:table-cell">Awarded</th>
                      <th className="hidden pb-2 text-right font-medium text-slate-500 sm:table-cell">Finalist Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fellowshipsByFinalists.map(({ id, name, total, semiFinalists, finalists, awarded }) => (
                      <tr key={`${id}:${name}`} className="border-b border-gray-50 last:border-0">
                        <td className="py-2">
                          <Link
                            href={`/fellowships/${id}`}
                            className="text-slate-700 hover:text-[#006747] hover:underline"
                          >
                            {name}
                          </Link>
                        </td>
                        <td className="py-2 text-center text-slate-500">{total}</td>
                        <td className="hidden py-2 text-center md:table-cell">
                          {semiFinalists > 0 ? (
                            <MetricBadge tone="purple" className="bg-purple-50 text-purple-800">
                              {semiFinalists}
                            </MetricBadge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="py-2 text-center">
                          {finalists > 0 ? (
                            <MetricBadge tone="green" className="bg-green-50 text-green-800">
                              {finalists}
                            </MetricBadge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="hidden py-2 text-center sm:table-cell">
                          {awarded > 0 ? (
                            <MetricBadge tone="amber" className="bg-amber-50 text-amber-900">
                              {awarded}
                            </MetricBadge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="hidden py-2 text-right text-slate-500 sm:table-cell">
                          {total > 0 ? `${Math.round((finalists / total) * 100)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── R4: Advising Meetings by Advisor ──────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              Advising Meetings by Advisor
            </CardTitle>
            <AppCardDescription>
              Total meetings held and no-show rates per advisor
            </AppCardDescription>
          </CardHeader>
          <CardContent>
            {data.advisorActivity.length === 0 ? (
              <p className="text-sm text-slate-400">No advising data yet.</p>
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {data.advisorActivity.map(({ id, name, total, noShows, students }) => {
                    const attended = total - noShows;
                    const rate = total > 0 ? Math.round((noShows / total) * 100) : 0;

                    return (
                      <div key={name} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                        <div className="flex items-start justify-between gap-3">
                          {id != null ? (
                            <Link
                              href={`/advisors/${id}`}
                              className="text-sm font-semibold text-slate-800 hover:text-primary hover:underline"
                            >
                              {name}
                            </Link>
                          ) : (
                            <span className="text-sm font-semibold italic text-slate-500">{name}</span>
                          )}
                          <MetricBadge tone="slate">{total} meetings</MetricBadge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <MetricBadge tone="green">{attended} attended</MetricBadge>
                          <MetricBadge tone="blue">{students} unique students</MetricBadge>
                          <MetricBadge tone={noShows > 0 ? "red" : "slate"}>{noShows} no-shows</MetricBadge>
                          <MetricBadge tone={rate >= 30 ? "red" : "slate"}>{total > 0 ? `${rate}% rate` : "No rate yet"}</MetricBadge>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-2 text-left font-medium text-slate-500">Advisor</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Meetings</th>
                      <th className="hidden pb-2 text-center font-medium text-slate-500 sm:table-cell">Unique Students</th>
                      <th className="hidden pb-2 text-center font-medium text-slate-500 sm:table-cell">Attended</th>
                      <th className="pb-2 text-center font-medium text-slate-500">No-Shows</th>
                      <th className="hidden pb-2 text-right font-medium text-slate-500 sm:table-cell">No-Show Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.advisorActivity.map(({ id, name, total, noShows, students }) => {
                      const attended = total - noShows;
                      const rate     = total > 0 ? Math.round((noShows / total) * 100) : 0;
                      return (
                        <tr key={name} className="border-b border-gray-50 last:border-0">
                          <td className="py-2">
                            {id != null ? (
                              <Link
                                href={`/advisors/${id}`}
                                className="text-slate-700 hover:text-[#006747] hover:underline"
                              >
                                {name}
                              </Link>
                            ) : (
                              <span className="text-slate-500 italic">{name}</span>
                            )}
                          </td>
                          <td className="py-2 text-center font-medium text-slate-700">{total}</td>
                          <td className="hidden py-2 text-center text-slate-500 sm:table-cell">{students}</td>
                          <td className="hidden py-2 text-center text-slate-500 sm:table-cell">{attended}</td>
                          <td className="py-2 text-center">
                            {noShows > 0 ? (
                              <MetricBadge tone="red" className="bg-red-50 text-red-700">
                                {noShows}
                              </MetricBadge>
                            ) : (
                              <span className="text-slate-300">0</span>
                            )}
                          </td>
                          <td className="hidden py-2 text-right sm:table-cell">
                            <span className={rate >= 30 ? "font-semibold text-red-600" : "text-slate-500"}>
                              {total > 0 ? `${rate}%` : "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">Advising Sessions by Student</CardTitle>
              <AppCardDescription>Recorded advising sessions for each student</AppCardDescription>
            </CardHeader>
            <CardContent>
              {data.advisingSessionsByStudent.length === 0 ? <p className="text-sm text-slate-400">No advising data yet.</p> : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {data.advisingSessionsByStudent.map(({ student_id, full_name, sessions }) => (
                    <li key={student_id} className="flex items-center justify-between gap-3 text-sm">
                      <Link href={`/students/${student_id}`} className="min-w-0 truncate text-slate-700 hover:text-[#006747] hover:underline">{full_name}</Link>
                      <MetricBadge tone="slate" className="shrink-0">{sessions} sessions</MetricBadge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">Advising Sessions by Student and Application/Fellowship</CardTitle>
              <AppCardDescription>Student sessions grouped by application link; unlinked meetings are General Advising</AppCardDescription>
            </CardHeader>
            <CardContent>
              {data.advisingSessionsByStudentApplication.length === 0 ? <p className="text-sm text-slate-400">No advising data yet.</p> : (
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {data.advisingSessionsByStudentApplication.map(({ student_id, full_name, application_id, label, sessions }) => (
                    <li key={`${student_id}:${application_id ?? "general"}`} className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm">
                      <div className="min-w-0"><Link href={`/students/${student_id}`} className="block truncate font-medium text-slate-700 hover:text-[#006747] hover:underline">{full_name}</Link><span className="text-xs text-slate-500">{application_id == null ? GENERAL_ADVISING_LABEL : label}</span></div>
                      <MetricBadge tone="slate" className="shrink-0">{sessions} sessions</MetricBadge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">Advising Sessions by Fellowship</CardTitle>
            <AppCardDescription>Sessions linked to an application for each fellowship; General Advising is excluded</AppCardDescription>
          </CardHeader>
          <CardContent>
            {data.advisingSessionsByFellowship.length === 0 ? <p className="text-sm text-slate-400">No fellowship-linked advising data yet.</p> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.advisingSessionsByFellowship.map(({ fellowship_id, label, sessions }) => (
                  <li key={fellowship_id} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2 text-sm"><span className="min-w-0 truncate text-slate-700">{label}</span><MetricBadge tone="slate" className="shrink-0">{sessions} sessions</MetricBadge></li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── R5: No-Show Trend ─────────────────────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              No-Show Trend
            </CardTitle>
            <AppCardDescription>
              Monthly meeting attendance over the last 6 months
            </AppCardDescription>
          </CardHeader>
          <CardContent>
            {data.noShowTrend.length === 0 ? (
              <p className="text-sm text-slate-400">No meeting data yet.</p>
            ) : (
              <div className="space-y-4">
                {data.noShowTrend.map(({ month, total, noShows }) => {
                  const attended = total - noShows;
                  const nsPct    = total > 0 ? Math.round((noShows  / total) * 100) : 0;
                  const barW     = Math.round((total / maxNS) * 100);
                  const nsBarW   = total > 0 ? Math.round((noShows  / total) * 100) : 0;
                  return (
                    <div key={month}>
                      <div className="mb-1.5 flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                        <span className="font-medium text-slate-700">{formatMonth(month)}</span>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          <span>{attended} attended</span>
                          <span className={noShows > 0 ? "text-red-500 font-medium" : ""}>
                            {noShows} no-show{noShows !== 1 ? "s" : ""} ({nsPct}%)
                          </span>
                        </div>
                      </div>
                      <div className="relative h-4 w-full rounded-full bg-gray-100 overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-[#006747] opacity-80 rounded-full"
                          style={{ width: `${barW - Math.round(barW * nsBarW / 100)}%` }}
                        />
                        <div
                          className="absolute inset-y-0 bg-red-400 rounded-r-full"
                          style={{
                            left:  `${barW - Math.round(barW * nsBarW / 100)}%`,
                            width: `${Math.round(barW * nsBarW / 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                <div className="flex gap-4 pt-1 text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#006747] opacity-80" />
                    Attended
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400" />
                    No-Show
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── R6 + R7: Gap & Funnel reports ─────────────────────────────────── */}
        <div className="grid gap-6 md:grid-cols-2">

          {/* R6: Students with advising but no application */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base font-semibold text-slate-900">
                    Advised, No Application Yet
                  </CardTitle>
                  <AppCardDescription>
                    Students who met with an advisor but haven&apos;t applied to any fellowship
                  </AppCardDescription>
                </div>
                <MetricBadge tone="amber" className="shrink-0 bg-amber-50 text-amber-700">
                  {data.advisingNoApplication.length}
                </MetricBadge>
              </div>
            </CardHeader>
            <CardContent>
              {data.advisingNoApplication.length === 0 ? (
                <p className="text-sm text-slate-400">No gaps found — great!</p>
              ) : (
                <ul className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                  {data.advisingNoApplication.map((s) => (
                    <li key={s.student_id} className="flex items-center justify-between text-sm">
                      <Link
                        href={`/students/${s.student_id}`}
                        className="text-slate-700 hover:text-[#006747] hover:underline"
                      >
                        {s.full_name}
                      </Link>
                      <span className="text-xs text-slate-400 truncate ml-2">
                        {s.class_standing ?? s.major ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* R7: FT → Application funnel */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Fellowship Thursday → Application Funnel
              </CardTitle>
              <AppCardDescription>
                Outreach conversion: FT attendees who did or did not go on to apply
              </AppCardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {data.totals.ftAttendees > 0 && (
                <div className="grid grid-cols-2 gap-4 rounded-lg border border-gray-100 bg-slate-50 px-4 py-3 text-sm sm:flex sm:flex-wrap sm:items-center">
                  <div className="text-center">
                    <p className="text-lg font-bold text-slate-900">{data.totals.ftAttendees}</p>
                    <p className="text-xs text-slate-500">FT Attendees</p>
                  </div>
                  <div className="hidden text-lg text-slate-300 sm:block">→</div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-[#006747]">{data.ftThenApplied.length}</p>
                    <p className="text-xs text-slate-500">Applied</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-amber-600">{data.ftNotYetApplied.length}</p>
                    <p className="text-xs text-slate-500">Not Yet</p>
                  </div>
                  <div className="col-span-2 border-t border-gray-200 pt-3 text-center sm:ml-auto sm:border-t-0 sm:pt-0 sm:text-right">
                    <p className="text-lg font-bold text-slate-700">
                      {Math.round((data.ftThenApplied.length / data.totals.ftAttendees) * 100)}%
                    </p>
                    <p className="text-xs text-slate-500">Conversion</p>
                  </div>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-[#006747] mb-1.5">
                    ✓ Applied ({data.ftThenApplied.length})
                  </p>
                  {data.ftThenApplied.length === 0 ? (
                    <p className="text-xs text-slate-400">None yet.</p>
                  ) : (
                    <ul className="space-y-1 max-h-44 overflow-y-auto pr-1">
                      {data.ftThenApplied.map((s) => (
                        <li key={s.student_id} className="text-xs">
                          <Link
                            href={`/students/${s.student_id}`}
                            className="text-slate-700 hover:text-[#006747] hover:underline"
                          >
                            {s.full_name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-amber-600 mb-1.5">
                    ⏳ Not Yet Applied ({data.ftNotYetApplied.length})
                  </p>
                  {data.ftNotYetApplied.length === 0 ? (
                    <p className="text-xs text-slate-400">Everyone applied!</p>
                  ) : (
                    <ul className="space-y-1 max-h-44 overflow-y-auto pr-1">
                      {data.ftNotYetApplied.map((s) => (
                        <li key={s.student_id} className="text-xs">
                          <Link
                            href={`/students/${s.student_id}`}
                            className="text-slate-700 hover:text-[#006747] hover:underline"
                          >
                            {s.full_name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </>
  );
}
