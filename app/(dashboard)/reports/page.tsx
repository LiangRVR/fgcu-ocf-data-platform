import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createServerClient } from "@/lib/supabase/server";
import Link from "next/link";

export const metadata: Metadata = { title: "Reports" };

// ── constants ─────────────────────────────────────────────────────────────────

const STAGE_ORDER = [
  "Started", "Submitted", "Under Review", "Semi-Finalist", "Finalist", "Awarded", "Rejected",
];

const CLASS_ORDER = ["Freshman", "Sophomore", "Junior", "Senior", "Graduate", "Doctoral"];

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

async function getReportsData() {
  const supabase = createServerClient();

  const [
    applicationsRes,
    meetingsRes,
    studentsRes,
    ftRes,
  ] = await Promise.all([
    supabase
      .from("application")
      .select("student_id, fellowship_id, stage_of_application, is_finalist, is_semi_finalist, student(full_name, major, class_standing), fellowship(fellowship_name)"),
    supabase
      .from("advising_meeting")
      .select("student_id, advisor_id, no_show, meeting_date, advisor(advisor_name)"),
    supabase
      .from("student")
      .select("student_id, full_name, major, class_standing"),
    supabase
      .from("fellowship_thursday")
      .select("student_id, attended"),
  ]);

  type AppRow = {
    student_id: number;
    fellowship_id: number;
    stage_of_application: string;
    is_finalist: boolean;
    is_semi_finalist: boolean;
    student: { full_name: string; major: string | null; class_standing: string | null } | null;
    fellowship: { fellowship_name: string } | null;
  };

  type MeetingRow = {
    student_id: number;
    advisor_id: number | null;
    no_show: boolean;
    meeting_date: string;
    advisor: { advisor_name: string } | null;
  };

  type StudentRow = {
    student_id: number;
    full_name: string;
    major: string | null;
    class_standing: string | null;
  };

  const applications  = (applicationsRes.data ?? []) as AppRow[];
  const meetings      = (meetingsRes.data ?? [])      as MeetingRow[];
  const students      = (studentsRes.data ?? [])      as StudentRow[];
  const ftRows        = (ftRes.data ?? [])            as Array<{ student_id: number; attended: boolean }>;

  // ── Report 1: Applications by Stage (pipeline order) ─────────────────────
  const stageMap = new Map<string, number>();
  for (const a of applications) {
    stageMap.set(a.stage_of_application, (stageMap.get(a.stage_of_application) ?? 0) + 1);
  }
  const applicationsByStage = STAGE_ORDER
    .filter((s) => stageMap.has(s))
    .map((stage) => ({ stage, count: stageMap.get(stage)! }));
  for (const [stage, count] of stageMap) {
    if (!STAGE_ORDER.includes(stage)) applicationsByStage.push({ stage, count });
  }

  // ── Report 2: Finalists & Awarded by Fellowship ───────────────────────────
  const fellowshipMap = new Map<number, { name: string; total: number; semiFinalists: number; finalists: number; awarded: number }>();
  for (const a of applications) {
    const name = a.fellowship?.fellowship_name ?? `Fellowship ${a.fellowship_id}`;
    const rec = fellowshipMap.get(a.fellowship_id) ?? { name, total: 0, semiFinalists: 0, finalists: 0, awarded: 0 };
    rec.total += 1;
    if (a.is_semi_finalist || a.stage_of_application === "Semi-Finalist") rec.semiFinalists += 1;
    if (a.is_finalist       || a.stage_of_application === "Finalist")      rec.finalists     += 1;
    if (a.stage_of_application === "Awarded")                               rec.awarded       += 1;
    fellowshipMap.set(a.fellowship_id, rec);
  }
  const fellowshipsByFinalists = [...fellowshipMap.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.finalists - a.finalists || b.awarded - a.awarded)
    .slice(0, 15);

  // ── Report 3: Students by Class Standing ─────────────────────────────────
  const classMap = new Map<string, number>();
  for (const s of students) {
    const cs = s.class_standing ?? "Unknown";
    classMap.set(cs, (classMap.get(cs) ?? 0) + 1);
  }
  const byClassStanding = CLASS_ORDER
    .filter((c) => classMap.has(c))
    .map((standing) => ({ standing, count: classMap.get(standing)! }));
  if (classMap.has("Unknown")) byClassStanding.push({ standing: "Unknown", count: classMap.get("Unknown")! });

  // ── Report 4: Advising Meetings by Advisor ────────────────────────────────
  const advisorMap = new Map<string, { id: number | null; name: string; total: number; noShows: number }>();
  for (const m of meetings) {
    const name = m.advisor?.advisor_name ?? "Unassigned";
    const key  = String(m.advisor_id ?? "none");
    const rec  = advisorMap.get(key) ?? { id: m.advisor_id ?? null, name, total: 0, noShows: 0 };
    rec.total += 1;
    if (m.no_show) rec.noShows += 1;
    advisorMap.set(key, rec);
  }
  const advisorActivity = [...advisorMap.values()].sort((a, b) => b.total - a.total);

  // ── Report 5: No-Show Trend (last 6 calendar months) ─────────────────────
  const monthMap = new Map<string, { total: number; noShows: number }>();
  for (const m of meetings) {
    const month = m.meeting_date.slice(0, 7); // "YYYY-MM"
    const rec   = monthMap.get(month) ?? { total: 0, noShows: 0 };
    rec.total += 1;
    if (m.no_show) rec.noShows += 1;
    monthMap.set(month, rec);
  }
  const noShowTrend = [...monthMap.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  // ── Report 6: Students with Advising but No Application ──────────────────
  const studentsWithApplications = new Set(applications.map((a) => a.student_id));
  const studentsWithMeetings     = new Set(meetings.map((m) => m.student_id));
  const advisingNoApplication = students.filter(
    (s) => studentsWithMeetings.has(s.student_id) && !studentsWithApplications.has(s.student_id),
  );

  // ── Report 7: FT Attendees → Applied / Not Yet Applied ───────────────────
  const ftAttendeeIds = new Set(ftRows.filter((r) => r.attended).map((r) => r.student_id));
  const ftThenApplied = students.filter(
    (s) => ftAttendeeIds.has(s.student_id) && studentsWithApplications.has(s.student_id),
  );
  const ftNotYetApplied = students.filter(
    (s) => ftAttendeeIds.has(s.student_id) && !studentsWithApplications.has(s.student_id),
  );

  return {
    applicationsByStage,
    fellowshipsByFinalists,
    byClassStanding,
    advisorActivity,
    noShowTrend,
    advisingNoApplication,
    ftThenApplied,
    ftNotYetApplied,
    totals: {
      students:       students.length,
      applications:   applications.length,
      meetings:       meetings.length,
      ftAttendees:    ftAttendeeIds.size,
      awarded:        applications.filter((a) => a.stage_of_application === "Awarded").length,
    },
  };
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function ReportsPage() {
  const data = await getReportsData();

  const maxStage = Math.max(1, ...data.applicationsByStage.map((r) => r.count));
  const maxClass = Math.max(1, ...data.byClassStanding.map((r) => r.count));
  const maxNS    = Math.max(1, ...data.noShowTrend.map((r) => r.total));

  return (
    <>
      <PageHeader
        title="Reports"
        description="Cross-table insights: applications, advising, fellowships, and student engagement"
      />

      <div className="space-y-8">

        {/* ── Summary stats ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: "Total Students",    value: data.totals.students },
            { label: "Applications",      value: data.totals.applications },
            { label: "Advising Meetings", value: data.totals.meetings },
            { label: "FT Attendees",      value: data.totals.ftAttendees },
            { label: "Awards",            value: data.totals.awarded },
          ].map(({ label, value }) => (
            <Card key={label} className="border-gray-200 shadow-sm">
              <CardContent className="pt-5 pb-4">
                <p className="text-2xl font-bold text-slate-900">{value}</p>
                <p className="text-xs text-slate-500 mt-0.5">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-2">

          {/* R1: Applications by Stage */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Applications by Stage
              </CardTitle>
              <p className="text-xs text-slate-500 mt-0.5">Pipeline from start to award</p>
            </CardHeader>
            <CardContent>
              {data.applicationsByStage.length === 0 ? (
                <p className="text-sm text-slate-400">No data yet.</p>
              ) : (
                <ul className="space-y-3">
                  {data.applicationsByStage.map(({ stage, count }) => (
                    <li key={stage}>
                      <div className="flex items-center justify-between mb-1">
                        <Badge variant="outline" className={stageBadgeClass(stage)}>
                          {stage}
                        </Badge>
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
              <p className="text-xs text-slate-500 mt-0.5">All enrolled students on record</p>
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
              Finalists &amp; Awarded Students by Fellowship
            </CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              How far applicants advance for each fellowship
            </p>
          </CardHeader>
          <CardContent>
            {data.fellowshipsByFinalists.length === 0 ? (
              <p className="text-sm text-slate-400">No data yet.</p>
            ) : (
              <div className="overflow-x-auto">
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
                      <tr key={id} className="border-b border-gray-50 last:border-0">
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
                            <Badge variant="outline" className="border-purple-200 bg-purple-50 text-purple-800">
                              {semiFinalists}
                            </Badge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="py-2 text-center">
                          {finalists > 0 ? (
                            <Badge variant="outline" className="border-green-200 bg-green-50 text-green-800">
                              {finalists}
                            </Badge>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="hidden py-2 text-center sm:table-cell">
                          {awarded > 0 ? (
                            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800 font-semibold">
                              {awarded}
                            </Badge>
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
            )}
          </CardContent>
        </Card>

        {/* ── R4: Advising Meetings by Advisor ──────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              Advising Meetings by Advisor
            </CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Total meetings held and no-show rates per advisor
            </p>
          </CardHeader>
          <CardContent>
            {data.advisorActivity.length === 0 ? (
              <p className="text-sm text-slate-400">No advising data yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-2 text-left font-medium text-slate-500">Advisor</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Meetings</th>
                      <th className="hidden pb-2 text-center font-medium text-slate-500 sm:table-cell">Attended</th>
                      <th className="pb-2 text-center font-medium text-slate-500">No-Shows</th>
                      <th className="hidden pb-2 text-right font-medium text-slate-500 sm:table-cell">No-Show Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.advisorActivity.map(({ id, name, total, noShows }) => {
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
                          <td className="hidden py-2 text-center text-slate-500 sm:table-cell">{attended}</td>
                          <td className="py-2 text-center">
                            {noShows > 0 ? (
                              <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                                {noShows}
                              </Badge>
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
            )}
          </CardContent>
        </Card>

        {/* ── R5: No-Show Trend ─────────────────────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              No-Show Trend
            </CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Monthly meeting attendance over the last 6 months
            </p>
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
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="font-medium text-slate-700 w-20 shrink-0 sm:w-24">{formatMonth(month)}</span>
                        <div className="flex gap-4 text-xs text-slate-500">
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
                  <p className="text-xs text-slate-500 mt-0.5">
                    Students who met with an advisor but haven&apos;t applied to any fellowship
                  </p>
                </div>
                <Badge variant="outline" className="shrink-0 border-amber-200 bg-amber-50 text-amber-700">
                  {data.advisingNoApplication.length}
                </Badge>
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
              <p className="text-xs text-slate-500 mt-0.5">
                Outreach conversion: FT attendees who did or did not go on to apply
              </p>
            </CardHeader>
            <CardContent className="space-y-5">
              {data.totals.ftAttendees > 0 && (
                <div className="flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 px-4 py-3 text-sm border border-gray-100">
                  <div className="text-center">
                    <p className="text-lg font-bold text-slate-900">{data.totals.ftAttendees}</p>
                    <p className="text-xs text-slate-500">FT Attendees</p>
                  </div>
                  <div className="text-slate-300 text-lg">→</div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-[#006747]">{data.ftThenApplied.length}</p>
                    <p className="text-xs text-slate-500">Applied</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-amber-600">{data.ftNotYetApplied.length}</p>
                    <p className="text-xs text-slate-500">Not Yet</p>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="text-lg font-bold text-slate-700">
                      {Math.round((data.ftThenApplied.length / data.totals.ftAttendees) * 100)}%
                    </p>
                    <p className="text-xs text-slate-500">Conversion</p>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
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
