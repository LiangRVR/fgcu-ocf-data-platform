import type { Metadata } from "next";
import {
  Users,
  Award,
  FileText,
  Star,
  CalendarCheck,
  UserCheck,
  GraduationCap,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

// ─── helpers ──────────────────────────────────────────────────────────────────

function countBy<T extends object>(
  arr: T[],
  key: keyof T
): Array<[string, number]> {
  const map: Record<string, number> = {};
  for (const item of arr) {
    const val = String((item[key] as string | boolean | null | undefined) ?? "Unknown");
    map[val] = (map[val] ?? 0) + 1;
  }
  return Object.entries(map).sort(([, a], [, b]) => b - a);
}

// ─── data fetching ────────────────────────────────────────────────────────────

async function getDashboardData() {
  const supabase = createServerClient();

  const now = new Date();
  const startOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const [
    studentsRes,
    fellowshipsRes,
    applicationsRes,
    finalistsRes,
    semiFinalistsRes,
    meetingsThisMonthRes,
    noShowsRes,
    appStagesRes,
    classStandingsRes,
    studentFlagsRes,
    finalistsByFellowshipRes,
    recentMeetingsRes,
    recentApplicationsRes,
  ] = await Promise.all([
    supabase.from("student").select("student_id", { count: "exact", head: true }),
    supabase.from("fellowship").select("fellowship_id", { count: "exact", head: true }),
    supabase.from("application").select("application_id", { count: "exact", head: true }),
    supabase
      .from("application")
      .select("application_id", { count: "exact", head: true })
      .eq("is_finalist", true),
    supabase
      .from("application")
      .select("application_id", { count: "exact", head: true })
      .eq("is_semi_finalist", true),
    supabase
      .from("advising_meeting")
      .select("meeting_id", { count: "exact", head: true })
      .gte("meeting_date", startOfMonth),
    supabase
      .from("advising_meeting")
      .select("meeting_id", { count: "exact", head: true })
      .eq("no_show", true),
    supabase.from("application").select("stage_of_application"),
    supabase.from("student").select("class_standing"),
    supabase.from("student").select("is_ch_student, honors_college, first_gen"),
    supabase
      .from("application")
      .select("fellowship(fellowship_name)")
      .eq("is_finalist", true),
    supabase
      .from("advising_meeting")
      .select("meeting_id, meeting_date, meeting_mode, no_show, student_id, student(full_name)")
      .order("meeting_date", { ascending: false })
      .limit(5),
    supabase
      .from("application")
      .select(
        "application_id, stage_of_application, is_finalist, is_semi_finalist, student_id, fellowship_id, student(full_name), fellowship(fellowship_name)"
      )
      .order("application_id", { ascending: false })
      .limit(5),
  ]);

  // Distribution: applications by stage
  const appsByStage = countBy(appStagesRes.data ?? [], "stage_of_application");

  // Distribution: students by class standing
  const studentsByStanding = countBy(classStandingsRes.data ?? [], "class_standing");

  // Student flag totals
  const flags = studentFlagsRes.data ?? [];
  const chCount = flags.filter((s) => s.is_ch_student).length;
  const honorsCount = flags.filter((s) => s.honors_college).length;
  const firstGenCount = flags.filter((s) => s.first_gen).length;

  // Finalists grouped by fellowship name
  const fbfMap: Record<string, number> = {};
  for (const row of finalistsByFellowshipRes.data ?? []) {
    const f = row.fellowship as { fellowship_name: string } | null;
    const name = f?.fellowship_name ?? "Unknown";
    fbfMap[name] = (fbfMap[name] ?? 0) + 1;
  }
  const finalistsByFellowship = Object.entries(fbfMap).sort(([, a], [, b]) => b - a);

  type RecentMeeting = {
    meeting_id: number;
    meeting_date: string;
    meeting_mode: string;
    no_show: boolean;
    student_id: number;
    student: { full_name: string } | null;
  };

  type RecentApplication = {
    application_id: number;
    stage_of_application: string;
    is_finalist: boolean;
    is_semi_finalist: boolean;
    student_id: number;
    fellowship_id: number;
    student: { full_name: string } | null;
    fellowship: { fellowship_name: string } | null;
  };

  return {
    stats: {
      totalStudents: studentsRes.count ?? 0,
      totalFellowships: fellowshipsRes.count ?? 0,
      totalApplications: applicationsRes.count ?? 0,
      finalists: finalistsRes.count ?? 0,
      semiFinalists: semiFinalistsRes.count ?? 0,
      meetingsThisMonth: meetingsThisMonthRes.count ?? 0,
      noShows: noShowsRes.count ?? 0,
      chStudents: chCount,
      honorsStudents: honorsCount,
      firstGenStudents: firstGenCount,
      totalStudentsForFlags: flags.length,
    },
    distributions: { appsByStage, studentsByStanding, finalistsByFellowship },
    recent: {
      meetings: (recentMeetingsRes.data ?? []) as RecentMeeting[],
      applications: (recentApplicationsRes.data ?? []) as RecentApplication[],
    },
  };
}

// ─── sub-components ───────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  bg,
  fg,
  href,
}: {
  title: string;
  value: number;
  sub: string;
  icon: React.ElementType;
  bg: string;
  fg: string;
  href?: string;
}) {
  const inner = (
    <CardContent className="p-4">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${bg}`}>
          <Icon className={`h-5 w-5 ${fg}`} />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold text-slate-900">{value.toLocaleString()}</div>
          <div className="truncate text-sm text-slate-500">{title}</div>
          <div className="truncate text-xs text-slate-400">{sub}</div>
        </div>
      </div>
    </CardContent>
  );
  return href ? (
    <Link href={href}>
      <Card className="border-gray-200 shadow-sm transition-shadow hover:shadow-md cursor-pointer">
        {inner}
      </Card>
    </Link>
  ) : (
    <Card className="border-gray-200 shadow-sm">{inner}</Card>
  );
}

function DistributionList({
  title,
  rows,
  total,
  barColor,
}: {
  title: string;
  rows: Array<[string, number]>;
  total: number;
  barColor: string;
}) {
  if (rows.length === 0) {
    return (
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-slate-700">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-400">No data yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-gray-200 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-slate-700">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {rows.map(([label, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <div key={label}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="max-w-[70%] truncate font-medium text-slate-700">{label}</span>
                <span className="text-slate-500">
                  {count} <span className="text-slate-400">({pct}%)</span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100">
                <div
                  className={`h-1.5 rounded-full ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const { stats, distributions, recent } = await getDashboardData();

  const now = new Date();
  const monthLabel = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live overview of students, fellowships, and advising activity."
      />

      {/* ── Primary stat cards ── */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Total Students"
          value={stats.totalStudents}
          sub="Tracked in the system"
          icon={Users}
          bg="bg-blue-100"
          fg="text-blue-600"
          href="/students"
        />
        <StatCard
          title="Active Fellowships"
          value={stats.totalFellowships}
          sub="Available programs"
          icon={Award}
          bg="bg-amber-100"
          fg="text-amber-600"
          href="/fellowships"
        />
        <StatCard
          title="Total Applications"
          value={stats.totalApplications}
          sub="All stages combined"
          icon={FileText}
          bg="bg-purple-100"
          fg="text-purple-600"
          href="/applications"
        />
        <StatCard
          title="Finalists"
          value={stats.finalists}
          sub="Reached finalist stage"
          icon={Star}
          bg="bg-green-100"
          fg="text-green-600"
          href="/applications?stage=Finalist"
        />
        <StatCard
          title="Semi-Finalists"
          value={stats.semiFinalists}
          sub="Reached semi-finalist stage"
          icon={UserCheck}
          bg="bg-teal-100"
          fg="text-teal-600"
          href="/applications?stage=Semi-Finalist"
        />
        <StatCard
          title="Advising This Month"
          value={stats.meetingsThisMonth}
          sub={monthLabel}
          icon={CalendarCheck}
          bg="bg-indigo-100"
          fg="text-indigo-600"
          href="/advising"
        />
      </div>

      {/* ── Student flag indicators ── */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "CH Students",
            count: stats.chStudents,
            icon: GraduationCap,
            bg: "bg-sky-100",
            fg: "text-sky-600",
            href: "/students",
          },
          {
            label: "Honors College",
            count: stats.honorsStudents,
            icon: Award,
            bg: "bg-yellow-100",
            fg: "text-yellow-600",
            href: "/students",
          },
          {
            label: "First-Generation",
            count: stats.firstGenStudents,
            icon: Users,
            bg: "bg-rose-100",
            fg: "text-rose-600",
            href: "/students",
          },
          {
            label: "Advising No-Shows",
            count: stats.noShows,
            icon: XCircle,
            bg: "bg-red-100",
            fg: "text-red-500",
            href: "/advising?no_show=yes",
          },
        ].map(({ label, count, icon: Icon, bg, fg, href }) => {
          const pct =
            label !== "Advising No-Shows" && stats.totalStudentsForFlags > 0
              ? Math.round((count / stats.totalStudentsForFlags) * 100)
              : null;
          const card = (
            <Card className={`border-gray-200 shadow-sm${href ? " cursor-pointer transition-shadow hover:shadow-md" : ""}`}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                  <Icon className={`h-4 w-4 ${fg}`} />
                </div>
                <div>
                  <div className="text-xl font-semibold text-slate-900">
                    {count.toLocaleString()}
                    {pct !== null && (
                      <span className="ml-1.5 text-sm font-normal text-slate-400">
                        {pct}%
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{label}</div>
                </div>
              </CardContent>
            </Card>
          );
          return href ? <Link key={label} href={href}>{card}</Link> : card;
        })}
      </div>

      {/* ── Distributions ── */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <DistributionList
          title="Applications by Stage"
          rows={distributions.appsByStage}
          total={stats.totalApplications}
          barColor="bg-purple-500"
        />
        <DistributionList
          title="Students by Class Standing"
          rows={distributions.studentsByStanding}
          total={stats.totalStudents}
          barColor="bg-blue-500"
        />
        <DistributionList
          title="Finalists by Fellowship"
          rows={distributions.finalistsByFellowship}
          total={stats.finalists}
          barColor="bg-green-500"
        />
      </div>

      {/* ── Recent activity ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recent advising meetings */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700">
              Recent Advising Meetings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recent.meetings.length === 0 ? (
              <p className="text-sm text-slate-400">No meetings recorded yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recent.meetings.map((m) => (
                  <li key={m.meeting_id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/students/${m.student_id}`}
                        className="truncate text-sm font-medium text-slate-800 hover:text-[#006747] hover:underline"
                      >
                        {m.student?.full_name ?? "Unknown Student"}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {formatDate(m.meeting_date)} · {m.meeting_mode}
                      </p>
                    </div>
                    {m.no_show && (
                      <Badge variant="destructive" className="ml-2 shrink-0 text-xs">
                        No-show
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent applications */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-700">
              Recent Applications
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recent.applications.length === 0 ? (
              <p className="text-sm text-slate-400">No applications recorded yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {recent.applications.map((a) => (
                  <li key={a.application_id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/students/${a.student_id}`}
                        className="block truncate text-sm font-medium text-slate-800 hover:text-[#006747] hover:underline"
                      >
                        {a.student?.full_name ?? "Unknown Student"}
                      </Link>
                      <Link
                        href={`/fellowships/${a.fellowship_id}`}
                        className="truncate text-xs text-slate-500 hover:text-[#006747] hover:underline"
                      >
                        {a.fellowship?.fellowship_name ?? "Unknown Fellowship"}
                      </Link>
                    </div>
                    <div className="ml-2 flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="outline" className="text-xs">
                        {a.stage_of_application}
                      </Badge>
                      {a.is_finalist && (
                        <Badge className="border-green-200 bg-green-100 text-xs text-green-800 hover:bg-green-100">
                          Finalist
                        </Badge>
                      )}
                      {!a.is_finalist && a.is_semi_finalist && (
                        <Badge variant="secondary" className="text-xs">
                          Semi-Finalist
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
