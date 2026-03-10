import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createServerClient } from "@/lib/supabase/server";
import Link from "next/link";

export const metadata: Metadata = { title: "Reports" };

// ── helpers ──────────────────────────────────────────────────────────────────

function stageBadgeClass(stage: string): string {
  switch (stage) {
    case "Semi-Finalist": return "border-purple-200 bg-purple-100 text-purple-800";
    case "Finalist":      return "border-green-200 bg-green-100 text-green-800";
    case "Awarded":       return "border-emerald-200 bg-emerald-100 text-emerald-800 font-semibold";
    case "Rejected":      return "border-red-200 bg-red-100 text-red-700";
    default:              return "border-gray-200 bg-gray-100 text-gray-700";
  }
}

// ── data fetching ─────────────────────────────────────────────────────────────

async function getReportsData() {
  const supabase = createServerClient();

  const [
    applicationsRes,
    meetingsRes,
    studentsRes,
    ftRes,
    historyRes,
  ] = await Promise.all([
    supabase
      .from("application")
      .select("student_id, fellowship_id, stage_of_application, is_finalist, is_semi_finalist, student(full_name, major), fellowship(fellowship_name)"),
    supabase
      .from("advising_meeting")
      .select("student_id, advisor_id, no_show, advisor(advisor_name)"),
    supabase
      .from("student")
      .select("student_id, full_name, major, gpa"),
    supabase
      .from("fellowship_thursday")
      .select("student_id"),
    supabase
      .from("scholarship_history")
      .select("student_id, fellowship_id, fellowship(fellowship_name)"),
  ]);

  const applications = (applicationsRes.data ?? []) as Array<{
    student_id: number; fellowship_id: number; stage_of_application: string;
    is_finalist: boolean; is_semi_finalist: boolean;
    student: { full_name: string; major: string | null } | null;
    fellowship: { fellowship_name: string } | null;
  }>;

  const meetings = (meetingsRes.data ?? []) as Array<{
    student_id: number; advisor_id: number | null; no_show: boolean;
    advisor: { advisor_name: string } | null;
  }>;

  const students = (studentsRes.data ?? []) as Array<{
    student_id: number; full_name: string; major: string | null; gpa: number | null;
  }>;

  const ftRows = (ftRes.data ?? []) as Array<{ student_id: number }>;
  const historyRows = (historyRes.data ?? []) as Array<{
    student_id: number; fellowship_id: number;
    fellowship: { fellowship_name: string } | null;
  }>;

  // ── 1. Applications by major ──────────────────────────────────────────────
  const majorMap = new Map<string, number>();
  for (const a of applications) {
    const major = a.student?.major ?? "Unknown";
    majorMap.set(major, (majorMap.get(major) ?? 0) + 1);
  }
  const applicationsByMajor = [...majorMap.entries()]
    .map(([major, count]) => ({ major, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── 2. Fellowships with the most finalists ────────────────────────────────
  const fellowshipFinalistMap = new Map<string, { name: string; finalists: number; total: number }>();
  for (const a of applications) {
    const name = a.fellowship?.fellowship_name ?? `Fellowship ${a.fellowship_id}`;
    const key = String(a.fellowship_id);
    const existing = fellowshipFinalistMap.get(key) ?? { name, finalists: 0, total: 0 };
    existing.total += 1;
    if (a.is_finalist) existing.finalists += 1;
    fellowshipFinalistMap.set(key, existing);
  }
  const fellowshipsByFinalists = [...fellowshipFinalistMap.values()]
    .sort((a, b) => b.finalists - a.finalists)
    .slice(0, 10);

  // ── 3. Students with advising but no application ──────────────────────────
  const studentsWithApplications = new Set(applications.map((a) => a.student_id));
  const studentsWithMeetings = new Set(meetings.map((m) => m.student_id));
  const advisingNoApplication = students.filter(
    (s) => studentsWithMeetings.has(s.student_id) && !studentsWithApplications.has(s.student_id)
  );

  // ── 4. Students who attended FT but have no application ──────────────────
  const ftStudentIds = new Set(ftRows.map((r) => r.student_id));
  const ftNoApplication = students.filter(
    (s) => ftStudentIds.has(s.student_id) && !studentsWithApplications.has(s.student_id)
  );

  // ── 5. No-show rates by advisor ───────────────────────────────────────────
  const advisorMap = new Map<string, { name: string; total: number; noShows: number }>();
  for (const m of meetings) {
    const name = m.advisor?.advisor_name ?? "Unassigned";
    const key = String(m.advisor_id ?? "none");
    const existing = advisorMap.get(key) ?? { name, total: 0, noShows: 0 };
    existing.total += 1;
    if (m.no_show) existing.noShows += 1;
    advisorMap.set(key, existing);
  }
  const advisorNoShows = [...advisorMap.values()]
    .filter((a) => a.name !== "Unassigned")
    .sort((a, b) => b.total - a.total);

  // ── 6. Recent stage outcomes ──────────────────────────────────────────────
  const stageMap = new Map<string, number>();
  for (const a of applications) {
    stageMap.set(a.stage_of_application, (stageMap.get(a.stage_of_application) ?? 0) + 1);
  }
  const stageBreakdown = [...stageMap.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);

  return {
    applicationsByMajor,
    fellowshipsByFinalists,
    advisingNoApplication,
    ftNoApplication,
    advisorNoShows,
    stageBreakdown,
    totals: {
      applications: applications.length,
      meetings: meetings.length,
      students: students.length,
      ftAttendees: ftStudentIds.size,
      awarded: applications.filter((a) => a.stage_of_application === "Awarded").length,
    },
  };
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function ReportsPage() {
  const data = await getReportsData();

  return (
    <>
      <PageHeader
        title="Reports"
        description="Cross-table insights across students, applications, advising, and fellowships"
      />

      <div className="space-y-8">

        {/* ── Summary row ─────────────────────────────────────────────────── */}
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

        {/* ── Two-column row ──────────────────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-2">

          {/* Applications by major */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Applications by Major
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.applicationsByMajor.length === 0 ? (
                <p className="text-sm text-slate-400">No data yet.</p>
              ) : (
                <ol className="space-y-2">
                  {data.applicationsByMajor.map(({ major, count }, i) => (
                    <li key={major} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-slate-700">
                        <span className="w-5 text-right text-slate-400 text-xs">{i + 1}.</span>
                        {major}
                      </span>
                      <Badge variant="outline" className="border-gray-200 bg-gray-50 text-gray-700 tabular-nums">
                        {count}
                      </Badge>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          {/* Stage breakdown */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Application Stage Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.stageBreakdown.length === 0 ? (
                <p className="text-sm text-slate-400">No data yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.stageBreakdown.map(({ stage, count }) => (
                    <li key={stage} className="flex items-center justify-between text-sm">
                      <Badge variant="outline" className={stageBadgeClass(stage)}>
                        {stage}
                      </Badge>
                      <Link
                        href={`/applications?stage=${encodeURIComponent(stage)}`}
                        className="text-slate-700 tabular-nums hover:text-[#006747] hover:underline"
                      >
                        {count}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

        </div>

        {/* ── Fellowships by finalists ─────────────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              Fellowships by Finalist Count
            </CardTitle>
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
                      <th className="pb-2 text-center font-medium text-slate-500">Total Apps</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Finalists</th>
                      <th className="pb-2 text-right font-medium text-slate-500">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fellowshipsByFinalists.map(({ name, total, finalists }) => (
                      <tr key={name} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 text-slate-700">{name}</td>
                        <td className="py-2 text-center text-slate-500">{total}</td>
                        <td className="py-2 text-center">
                          <Badge variant="outline" className="border-green-200 bg-green-50 text-green-800">
                            {finalists}
                          </Badge>
                        </td>
                        <td className="py-2 text-right text-slate-500">
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

        {/* ── Advisor activity row ─────────────────────────────────────────── */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">
              Advisor Activity &amp; No-Show Rates
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.advisorNoShows.length === 0 ? (
              <p className="text-sm text-slate-400">No advising data yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-2 text-left font-medium text-slate-500">Advisor</th>
                      <th className="pb-2 text-center font-medium text-slate-500">Meetings</th>
                      <th className="pb-2 text-center font-medium text-slate-500">No-Shows</th>
                      <th className="pb-2 text-right font-medium text-slate-500">No-Show Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.advisorNoShows.map(({ name, total, noShows }) => (
                      <tr key={name} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 text-slate-700">{name}</td>
                        <td className="py-2 text-center text-slate-500">{total}</td>
                        <td className="py-2 text-center">
                          {noShows > 0 ? (
                            <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">
                              {noShows}
                            </Badge>
                          ) : (
                            <span className="text-slate-400">0</span>
                          )}
                        </td>
                        <td className="py-2 text-right text-slate-500">
                          {total > 0 ? `${Math.round((noShows / total) * 100)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Gap reports row ──────────────────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-2">

          {/* Advising but no application */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                Advised But No Application
                <Badge variant="outline" className="ml-2 border-amber-200 bg-amber-50 text-amber-700">
                  {data.advisingNoApplication.length}
                </Badge>
              </CardTitle>
              <p className="text-xs text-slate-500 mt-0.5">
                Students who had advising meetings but have not yet submitted an application.
              </p>
            </CardHeader>
            <CardContent>
              {data.advisingNoApplication.length === 0 ? (
                <p className="text-sm text-slate-400">No gaps found — great!</p>
              ) : (
                <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {data.advisingNoApplication.map((s) => (
                    <li key={s.student_id} className="flex items-center justify-between text-sm">
                      <Link
                        href={`/students/${s.student_id}`}
                        className="text-slate-700 hover:text-[#006747] hover:underline"
                      >
                        {s.full_name}
                      </Link>
                      {s.major && (
                        <span className="text-xs text-slate-400">{s.major}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Fellowship Thursday but no application */}
          <Card className="border-gray-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold text-slate-900">
                FT Attendee But No Application
                <Badge variant="outline" className="ml-2 border-amber-200 bg-amber-50 text-amber-700">
                  {data.ftNoApplication.length}
                </Badge>
              </CardTitle>
              <p className="text-xs text-slate-500 mt-0.5">
                Students who attended Fellowship Thursday but have not applied to any fellowship.
              </p>
            </CardHeader>
            <CardContent>
              {data.ftNoApplication.length === 0 ? (
                <p className="text-sm text-slate-400">No gaps found — great!</p>
              ) : (
                <ul className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {data.ftNoApplication.map((s) => (
                    <li key={s.student_id} className="flex items-center justify-between text-sm">
                      <Link
                        href={`/students/${s.student_id}`}
                        className="text-slate-700 hover:text-[#006747] hover:underline"
                      >
                        {s.full_name}
                      </Link>
                      {s.major && (
                        <span className="text-xs text-slate-400">{s.major}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

        </div>
      </div>
    </>
  );
}
