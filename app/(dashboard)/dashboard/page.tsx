import type { Metadata } from "next";
import {
  Users,
  Award,
  FileText,
  CalendarCheck,
  GraduationCap,
  XCircle,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
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
import { StatCard } from "@/components/ui/stat-card";
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

  try {
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
      error: false as const,
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
  } catch (err) {
    console.error("Dashboard data fetch failed:", err);
    return { error: true as const };
  }
}

function DistributionList({
  title,
  rows,
  total,
  barColor,
  getHref,
}: {
  title: string;
  rows: Array<[string, number]>;
  total: number;
  barColor: string;
  getHref?: (label: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <AppCard>
        <AppCardHeader className="pb-2">
          <AppCardTitle className="text-sm font-semibold text-slate-700">{title}</AppCardTitle>
        </AppCardHeader>
        <AppCardContent>
          <p className="text-sm text-slate-400">No data yet.</p>
        </AppCardContent>
      </AppCard>
    );
  }

  return (
    <AppCard>
      <AppCardHeader className="pb-2">
        <AppCardTitle className="text-sm font-semibold text-slate-700">{title}</AppCardTitle>
      </AppCardHeader>
      <AppCardContent className="space-y-2.5">
        {rows.map(([label, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const href = getHref?.(label);
          const inner = (
            <div className={href ? "group cursor-pointer rounded-md p-1 -mx-1 motion-safe:transition-colors hover:bg-slate-50" : ""}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className={`max-w-[70%] truncate font-medium ${href ? "text-slate-700 group-hover:text-[#006747]" : "text-slate-700"}`}>
                  {label}
                </span>
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
          return href ? (
            <Link key={label} href={href}>
              {inner}
            </Link>
          ) : (
            <div key={label}>{inner}</div>
          );
        })}
      </AppCardContent>
    </AppCard>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const result = await getDashboardData();

  const now = new Date();
  const monthLabel = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  if (result.error) {
    return (
      <>
        <PageHeader
          eyebrow="Command Center"
          title="Dashboard"
          description="Executive overview of pipeline health, student reach, and advising activity across the OCF workspace."
        >
          <MetricBadge tone="slate">{monthLabel}</MetricBadge>
        </PageHeader>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-5 py-4 text-sm text-destructive">
          <strong>Could not load dashboard data.</strong> The database may be temporarily unavailable. Please refresh the page.
        </div>
      </>
    );
  }

  const { stats, distributions, recent } = result;
  const startedApplications = distributions.appsByStage.find(([label]) => label === "Started")?.[1] ?? 0;
  const underReviewApplications = distributions.appsByStage.find(([label]) => label === "Under Review")?.[1] ?? 0;
  const finalistRate = stats.totalApplications > 0 ? Math.round((stats.finalists / stats.totalApplications) * 100) : 0;
  const noShowRate = stats.meetingsThisMonth > 0 ? Math.round((stats.noShows / stats.meetingsThisMonth) * 100) : 0;

  return (
    <>
      <PageHeader
        eyebrow="Command Center"
        title="Dashboard"
        description="Executive overview of pipeline health, student reach, and advising activity across the OCF workspace."
      >
        <MetricBadge tone="green">Live data</MetricBadge>
        <MetricBadge tone="slate">{monthLabel}</MetricBadge>
      </PageHeader>

      <AppCard variant="elevated" className="mb-8 overflow-hidden">
        <AppCardContent className="grid gap-6 p-6 sm:p-7 lg:grid-cols-[1.45fr_0.95fr] lg:items-end">
          <div className="space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              <Sparkles className="h-3.5 w-3.5" />
              Admissions and advising pulse
            </div>
            <div className="space-y-3">
              <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                Keep the product focused on momentum, not just counts.
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-slate-500 sm:text-base">
                This view prioritizes high-signal metrics, pipeline concentration, and advisor follow-up opportunities so the team can act quickly.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-2xl border border-border/70 bg-surface-subtle p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Finalist rate</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{finalistRate}%</p>
              <p className="mt-1 text-xs text-slate-500">of current applications reached finalist status</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-surface-subtle p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">No-show pressure</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{stats.noShows}</p>
              <p className="mt-1 text-xs text-slate-500">{noShowRate}% of meetings recorded this month were no-shows</p>
            </div>
          </div>
        </AppCardContent>
      </AppCard>

      <PageSection
        title="Executive Snapshot"
        description="Top-line student, fellowship, application, and advising metrics with direct drill-down links."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Total Students"
          value={stats.totalStudents.toLocaleString()}
          description="Tracked in the system"
          icon={Users}
          tone="blue"
          href="/students"
          trend={`${stats.chStudents} CH students`}
        />
        <StatCard
          title="Active Fellowships"
          value={stats.totalFellowships.toLocaleString()}
          description="Available programs"
          icon={Award}
          tone="amber"
          href="/fellowships"
          trend={`${stats.finalists} active finalists`}
        />
        <StatCard
          title="Total Applications"
          value={stats.totalApplications.toLocaleString()}
          description="All stages combined"
          icon={FileText}
          tone="violet"
          href="/applications"
          trend={`${underReviewApplications} under review`}
        />
        <StatCard
          title="Advising This Month"
          value={stats.meetingsThisMonth.toLocaleString()}
          description={monthLabel}
          icon={CalendarCheck}
          tone="green"
          href="/advising"
          trend={`${stats.noShows} no-shows recorded`}
        />
        </div>
      </PageSection>

      <PageSection
        title="Student Signals"
        description="Flags and advising outcomes that shape outreach, triage, and support planning."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "CH Students",
            count: stats.chStudents,
            icon: GraduationCap,
            tone: "blue",
            href: "/students?flag=ch",
          },
          {
            label: "Honors College",
            count: stats.honorsStudents,
            icon: Award,
            tone: "amber",
            href: "/students?flag=honors",
          },
          {
            label: "First-Generation",
            count: stats.firstGenStudents,
            icon: Users,
            tone: "violet",
            href: "/students?flag=first_gen",
          },
          {
            label: "Advising No-Shows",
            count: stats.noShows,
            icon: XCircle,
            tone: "rose",
            href: "/advising?no_show=yes",
          },
        ].map(({ label, count, icon: Icon, tone, href }) => {
          const pct =
            label !== "Advising No-Shows" && stats.totalStudentsForFlags > 0
              ? Math.round((count / stats.totalStudentsForFlags) * 100)
              : null;
          return (
            <StatCard
              key={label}
              title={label}
              value={`${count.toLocaleString()}${pct !== null ? ` · ${pct}%` : ""}`}
              description={pct !== null ? "Share of tracked students" : "Recorded across advising history"}
              icon={Icon}
              tone={tone as "blue" | "amber" | "violet" | "rose"}
              href={href}
              trend={pct !== null ? "Student profile signal" : "Needs follow-up"}
            />
          );
        })}
        </div>
      </PageSection>

      <PageSection
        title="Operational Signals"
        description="Pipeline composition, student distribution, and the places where advisor attention can move outcomes fastest."
      >
        <div className="grid gap-4 xl:grid-cols-[1.1fr_1.1fr_1fr]">
          <DistributionList
            title="Applications by Stage"
            rows={distributions.appsByStage}
            total={stats.totalApplications}
            barColor="bg-purple-500"
            getHref={(label) => `/applications?stage=${encodeURIComponent(label)}`}
          />
          <DistributionList
            title="Students by Class Standing"
            rows={distributions.studentsByStanding}
            total={stats.totalStudents}
            barColor="bg-blue-500"
            getHref={(label) => `/students?standing=${encodeURIComponent(label)}`}
          />
          <AppCard variant="soft">
            <AppCardHeader>
              <AppCardTitle>Attention Needed</AppCardTitle>
              <AppCardDescription>Prioritize these queues for advisor follow-up and pipeline movement.</AppCardDescription>
            </AppCardHeader>
            <AppCardContent className="space-y-3">
              {[
                {
                  label: "Started applications",
                  value: startedApplications,
                  href: "/applications?stage=Started",
                  tone: "purple" as const,
                },
                {
                  label: "Under review",
                  value: underReviewApplications,
                  href: "/applications?stage=Under%20Review",
                  tone: "blue" as const,
                },
                {
                  label: "Advising no-shows",
                  value: stats.noShows,
                  href: "/advising?no_show=yes",
                  tone: "red" as const,
                },
              ].map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className="flex items-center justify-between rounded-2xl border border-border/70 bg-white px-4 py-3 text-sm motion-safe:transition-colors hover:border-emerald-200 hover:bg-emerald-50/40"
                >
                  <div>
                    <p className="font-medium text-slate-800">{item.label}</p>
                    <p className="mt-1 text-xs text-slate-500">Open the linked workflow and act from the list view.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <MetricBadge tone={item.tone}>{item.value}</MetricBadge>
                    <ArrowRight className="h-4 w-4 text-slate-400" />
                  </div>
                </Link>
              ))}
            </AppCardContent>
          </AppCard>
        </div>
      </PageSection>

      <PageSection
        title="Recent Activity"
        description="Latest advising and application activity with direct links into the student and fellowship records."
      >
      <div className="grid gap-4 md:grid-cols-2">
        {/* Recent advising meetings */}
        <AppCard>
          <AppCardHeader className="pb-2">
            <AppCardTitle className="text-sm font-semibold text-slate-700">
              Recent Advising Meetings
            </AppCardTitle>
          </AppCardHeader>
          <AppCardContent>
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
                      <MetricBadge tone="red" className="ml-2 shrink-0 text-xs">
                        No-show
                      </MetricBadge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </AppCardContent>
        </AppCard>

        {/* Recent applications */}
        <AppCard>
          <AppCardHeader className="pb-2">
            <AppCardTitle className="text-sm font-semibold text-slate-700">
              Recent Applications
            </AppCardTitle>
          </AppCardHeader>
          <AppCardContent>
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
                      <MetricBadge tone="slate" className="text-xs">
                        {a.stage_of_application}
                      </MetricBadge>
                      {a.is_finalist && (
                        <MetricBadge tone="green" className="text-xs">
                          Finalist
                        </MetricBadge>
                      )}
                      {!a.is_finalist && a.is_semi_finalist && (
                        <MetricBadge tone="purple" className="text-xs">
                          Semi-Finalist
                        </MetricBadge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </AppCardContent>
        </AppCard>
      </div>
      </PageSection>
    </>
  );
}
