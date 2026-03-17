import { notFound } from "next/navigation";
import {
  AppCard as Card,
  AppCardContent as CardContent,
  AppCardHeader as CardHeader,
  AppCardTitle as CardTitle,
} from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ActivityTimeline } from "@/components/ui/activity-timeline";
import {
  ArrowLeft,
  Mail,
  GraduationCap,
  Award,
  CalendarDays,
  MessageSquare,
  Trophy,
  CheckCircle2,
  XCircle,
  FilePlus,
  CalendarPlus,
  BookOpen,
  Activity,
} from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import { StudentInfoEditor } from "@/components/students/student-info-editor";
import { DetailSection } from "@/components/ui/detail-section";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityHeader } from "@/components/ui/entity-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import { formatDate } from "@/lib/utils/format";

type Student = Database["public"]["Tables"]["student"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"] & {
  created_at?: string | null;
  fellowship: { fellowship_name: string } | null;
};
type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  advisor: { advisor_name: string } | null;
};
type FellowshipThursday = Database["public"]["Tables"]["fellowship_thursday"]["Row"];
type ScholarshipHistory = Database["public"]["Tables"]["scholarship_history"]["Row"] & {
  fellowship: { fellowship_name: string } | null;
};

interface StudentDetailPageProps {
  params: Promise<{ id: string }>;
}

async function getStudent(id: number): Promise<Student | null> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("student")
      .select("*")
      .eq("student_id", id)
      .single();

    if (error) {
      console.error("Error fetching student:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("Error fetching student:", error);
    return null;
  }
}

async function getApplications(studentId: number): Promise<Application[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("application")
      .select("*, fellowship(fellowship_name)")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching applications:", error);
      return [];
    }

    return (data as Application[]) || [];
  } catch (error) {
    console.error("Error fetching applications:", error);
    return [];
  }
}

async function getAdvisingMeetings(studentId: number): Promise<AdvisingMeeting[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("advising_meeting")
      .select("*, advisor(advisor_name)")
      .eq("student_id", studentId)
      .order("meeting_date", { ascending: false });
    if (error) return [];
    return (data as AdvisingMeeting[]) || [];
  } catch {
    return [];
  }
}

async function getFellowshipThursday(studentId: number): Promise<FellowshipThursday[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("fellowship_thursday")
      .select("*")
      .eq("student_id", studentId);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

async function getScholarshipHistory(studentId: number): Promise<ScholarshipHistory[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("scholarship_history")
      .select("*, fellowship(fellowship_name)")
      .eq("student_id", studentId);
    if (error) return [];
    return (data as ScholarshipHistory[]) || [];
  } catch {
    return [];
  }
}

export default async function StudentDetailPage({ params }: StudentDetailPageProps) {
  const { id } = await params;
  const studentId = parseInt(id);

  if (isNaN(studentId)) {
    notFound();
  }

  const [student, applications, advisingMeetings, fellowshipThursday, scholarshipHistory] =
    await Promise.all([
      getStudent(studentId),
      getApplications(studentId),
      getAdvisingMeetings(studentId),
      getFellowshipThursday(studentId),
      getScholarshipHistory(studentId),
    ]);

  if (!student) {
    notFound();
  }

  // Derived summary stats
  const finalistCount = applications.filter((a) => a.is_finalist).length;
  const noShowCount = advisingMeetings.filter((m) => m.no_show).length;
  const ftAttended = fellowshipThursday.filter((r) => r.attended).length;

  // Activity timeline – merge all dated events
  type TimelineEvent = {
    id: string;
    kind: "application" | "meeting";
    date: string;
    title: string;
    description: string;
    href: string;
    badge: string;
    tone: "blue" | "purple" | "red";
  };

  const timeline: TimelineEvent[] = [
    ...applications.map((a) => ({
      id: `application-${a.application_id}`,
      kind: "application" as const,
      date: a.created_at ?? "",
      title: a.fellowship?.fellowship_name ?? `Fellowship #${a.fellowship_id}`,
      description: [a.stage_of_application, a.destination_country].filter(Boolean).join(" · "),
      href: `/fellowships/${a.fellowship_id}`,
      badge: "Application",
      tone: "purple" as const,
    })),
    ...advisingMeetings.map((m) => ({
      id: `meeting-${m.meeting_id}`,
      kind: "meeting" as const,
      date: m.meeting_date,
      title: m.no_show ? "Missed advising meeting" : "Advising meeting",
      description: `${m.meeting_mode}${m.no_show ? " · No-show" : " · Attended"}${m.advisor ? ` · ${m.advisor.advisor_name}` : ""}`,
      href: m.advisor_id ? `/advisors/${m.advisor_id}` : "/advising",
      badge: "Meeting",
      tone: m.no_show ? "red" : "blue",
    })),
  ]
    .filter((event) => Boolean(event.date))
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <>
      <EntityHeader
        kicker="Student Record"
        title={student.full_name}
        description={`Student ID ${student.student_id}${student.major ? ` • ${student.major}` : ""}`}
        badges={
          <>
            {student.is_ch_student ? <MetricBadge tone="green">CH Student</MetricBadge> : null}
            {student.honors_college ? <MetricBadge tone="blue">Honors College</MetricBadge> : null}
            {student.first_gen ? <MetricBadge tone="purple">First Generation</MetricBadge> : null}
            {student.us_citizen ? <MetricBadge tone="slate">U.S. Citizen</MetricBadge> : null}
          </>
        }
        meta={
          <>
            <span className="inline-flex items-center gap-2"><Mail className="h-4 w-4" />{student.email}</span>
            {student.class_standing ? <span className="inline-flex items-center gap-2"><GraduationCap className="h-4 w-4" />{student.class_standing}</span> : null}
          </>
        }
        actions={
          <>
            <Link href={`/applications?add=1&student_id=${student.student_id}`}>
              <Button size="sm">
                <FilePlus className="mr-2 h-4 w-4" />
                Add Application
              </Button>
            </Link>
            <Link href={`/advising?add=1&student_id=${student.student_id}`}>
              <Button size="sm" variant="outline">
                <CalendarPlus className="mr-2 h-4 w-4" />
                Log Meeting
              </Button>
            </Link>
            <Link href="/students">
              <Button variant="outline" size="sm">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
            </Link>
          </>
        }
        summary={
          <>
            {[
              { label: "Applications", value: applications.length },
              { label: "Finalists", value: finalistCount },
              { label: "Meetings", value: advisingMeetings.length },
              { label: "No-Shows", value: noShowCount },
              { label: "FT Attended", value: ftAttended },
              { label: "Scholarships", value: scholarshipHistory.length },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-400">{item.label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{item.value}</p>
              </div>
            ))}
          </>
        }
      />

      <div className="space-y-6">
        {/* Basic / Academic / Personal — inline-editable */}
        <StudentInfoEditor initialStudent={student} />

        {/* Applications Section */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">
              Applications
              {applications.length > 0 && (
                <span className="ml-2 text-sm font-normal text-slate-500">
                  ({applications.length})
                </span>
              )}
            </CardTitle>
            <Link href={`/applications?add=1&student_id=${student.student_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <FilePlus className="mr-1.5 h-3.5 w-3.5" />
                Add Application
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {applications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <Award className="h-8 w-8 text-gray-400" />
                </div>
                <p className="mb-3 text-sm text-slate-500">
                  No applications found for this student.
                </p>
                <Link href={`/applications?add=1&student_id=${student.student_id}`}>
                  <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
                    <FilePlus className="mr-2 h-4 w-4" />
                    Add First Application
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {applications.map((app) => (
                    <div key={app.application_id} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <Link
                          href={`/fellowships/${app.fellowship_id}`}
                          className="min-w-0 text-sm font-semibold text-slate-900 hover:text-primary hover:underline"
                        >
                          <span className="line-clamp-2">
                            {app.fellowship?.fellowship_name ?? `Fellowship #${app.fellowship_id}`}
                          </span>
                        </Link>
                        <MetricBadge tone="slate">{app.stage_of_application || "Pending"}</MetricBadge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricBadge tone="slate">
                          {app.destination_country || "No destination"}
                        </MetricBadge>
                        {app.is_finalist ? (
                          <MetricBadge tone="blue">Finalist</MetricBadge>
                        ) : app.is_semi_finalist ? (
                          <MetricBadge tone="purple">Semi-Finalist</MetricBadge>
                        ) : (
                          <MetricBadge tone="slate">Applicant</MetricBadge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Fellowship</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Stage</th>
                      <th className="hidden pb-3 text-left font-medium text-slate-500 md:table-cell">Destination</th>
                      <th className="hidden pb-3 text-left font-medium text-slate-500 sm:table-cell">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {applications.map((app) => (
                      <tr key={app.application_id} className="py-2">
                        <td className="py-3 pr-4 font-medium">
                          <Link
                            href={`/fellowships/${app.fellowship_id}`}
                            className="text-slate-900 hover:text-[#006747] hover:underline"
                          >
                            {app.fellowship?.fellowship_name ?? `Fellowship #${app.fellowship_id}`}
                          </Link>
                        </td>
                        <td className="py-3 pr-4 text-slate-700">
                          {app.stage_of_application || "—"}
                        </td>
                        <td className="hidden py-3 pr-4 text-slate-700 md:table-cell">
                          {app.destination_country || "—"}
                        </td>
                        <td className="hidden py-3 sm:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {app.is_finalist && (
                              <Badge className="border-blue-200 bg-blue-100 text-blue-800 hover:bg-blue-100">
                                Finalist
                              </Badge>
                            )}
                            {app.is_semi_finalist && !app.is_finalist && (
                              <Badge className="border-purple-200 bg-purple-100 text-purple-800 hover:bg-purple-100">
                                Semi-Finalist
                              </Badge>
                            )}
                            {!app.is_finalist && !app.is_semi_finalist && (
                              <Badge
                                variant="secondary"
                                className="border-gray-200 bg-gray-100 text-gray-600 hover:bg-gray-100"
                              >
                                Applicant
                              </Badge>
                            )}
                          </div>
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

        {/* Advising Meetings Section */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarDays className="h-5 w-5 text-slate-400" />
              Advising Meetings
              {advisingMeetings.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({advisingMeetings.length})
                </span>
              )}
            </CardTitle>
            <Link href={`/advising?add=1&student_id=${student.student_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
                Log Meeting
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {advisingMeetings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <MessageSquare className="h-8 w-8 text-gray-400" />
                </div>
                <p className="mb-3 text-sm text-slate-500">No advising meetings on record.</p>
                <Link href={`/advising?add=1&student_id=${student.student_id}`}>
                  <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
                    <CalendarPlus className="mr-2 h-4 w-4" />
                    Log First Meeting
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {advisingMeetings.map((meeting) => (
                    <div key={meeting.meeting_id} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <MetricBadge tone="slate">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </MetricBadge>
                        <MetricBadge tone={meeting.no_show ? "red" : "green"}>
                          {meeting.no_show ? "No-Show" : "Attended"}
                        </MetricBadge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                          {meeting.meeting_mode}
                        </MetricBadge>
                        {meeting.advisor_id ? (
                          <Link href={`/advisors/${meeting.advisor_id}`}>
                            <MetricBadge tone="slate" className="cursor-pointer hover:border-slate-300">
                              {meeting.advisor?.advisor_name ?? "Advisor"}
                            </MetricBadge>
                          </Link>
                        ) : null}
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {meeting.notes || "No notes recorded yet."}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Date</th>
                      <th className="hidden pb-3 text-left font-medium text-slate-500 sm:table-cell">Mode</th>
                      <th className="hidden pb-3 text-left font-medium text-slate-500 md:table-cell">Advisor</th>
                      <th className="pb-3 text-left font-medium text-slate-500">No-Show</th>
                      <th className="hidden pb-3 text-left font-medium text-slate-500 lg:table-cell">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {advisingMeetings.map((meeting) => (
                      <tr key={meeting.meeting_id}>
                        <td className="py-3 pr-4 text-slate-700">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td className="hidden py-3 pr-4 text-slate-700 sm:table-cell">
                          {meeting.meeting_mode}
                        </td>
                        <td className="hidden py-3 pr-4 md:table-cell">
                          {meeting.advisor_id ? (
                            <Link
                              href={`/advisors/${meeting.advisor_id}`}
                              className="text-slate-700 hover:text-[#006747] hover:underline"
                            >
                              {meeting.advisor?.advisor_name ?? "—"}
                            </Link>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {meeting.no_show ? (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <XCircle className="h-4 w-4" />
                              No-Show
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-green-600">
                              <CheckCircle2 className="h-4 w-4" />
                              Attended
                            </span>
                          )}
                        </td>
                        <td className="hidden max-w-xs py-3 text-slate-600 lg:table-cell">
                          {meeting.notes || <span className="text-slate-400">—</span>}
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

        {/* Fellowship Thursday Attendance */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarDays className="h-5 w-5 text-slate-400" />
              Fellowship Thursday
              {fellowshipThursday.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({ftAttended} attended / {fellowshipThursday.length} total)
                </span>
              )}
            </CardTitle>
            <Link href={`/fellowship-thursday?add=1&student_id=${student.student_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
                Log Attendance
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {fellowshipThursday.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <CalendarDays className="h-8 w-8 text-gray-400" />
                </div>
                <p className="mb-3 text-sm text-slate-500">No Fellowship Thursday records.</p>
                <Link href={`/fellowship-thursday?add=1&student_id=${student.student_id}`}>
                  <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
                    <CalendarPlus className="mr-2 h-4 w-4" />
                    Log First Attendance
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-3 md:hidden">
                  {fellowshipThursday.map((record) => (
                    <div key={record.attendance_id} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <MetricBadge tone={record.attended ? "green" : "red"}>
                          {record.attended ? "Attended" : "Absent"}
                        </MetricBadge>
                        <MetricBadge tone="slate">Fellowship Thursday</MetricBadge>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {record.source_info || "No source or context recorded."}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Attendance</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Source / Info</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {fellowshipThursday.map((record) => (
                      <tr key={record.attendance_id}>
                        <td className="py-3 pr-4">
                          {record.attended ? (
                            <span className="inline-flex items-center gap-1 text-green-600">
                              <CheckCircle2 className="h-4 w-4" />
                              Attended
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-red-600">
                              <XCircle className="h-4 w-4" />
                              Absent
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-slate-600">
                          {record.source_info || <span className="text-slate-400">—</span>}
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

        {/* Scholarship History */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Trophy className="h-5 w-5 text-amber-500" />
              Scholarship History
              {scholarshipHistory.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({scholarshipHistory.length} award{scholarshipHistory.length !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
            <Link href={`/scholarship-history?add=1&student_id=${student.student_id}`}>
              <Button size="sm" variant="outline" className="h-8 text-xs">
                <BookOpen className="mr-1.5 h-3.5 w-3.5" />
                Add History
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {scholarshipHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <Trophy className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-sm text-slate-500">
                  No scholarship awards recorded for this student.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {scholarshipHistory.map((record) => (
                  <Link
                    key={record.history_id}
                    href={`/fellowships/${record.fellowship_id}`}
                  >
                    <Badge className="border-amber-200 bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-200 cursor-pointer">
                      <Trophy className="mr-1.5 h-3.5 w-3.5" />
                      {record.fellowship?.fellowship_name ?? `Fellowship #${record.fellowship_id}`}
                    </Badge>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <DetailSection
          title="Recent Activity"
          description="A unified timeline of the student’s latest advising and application activity with direct links into the related workflow."
          icon={<Activity className="h-5 w-5" />}
          actions={<MetricBadge tone="slate">{timeline.length} events</MetricBadge>}
        >
          {timeline.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No recent activity yet"
              description="Applications and advising meetings will appear here as a single timeline once they are added to the student record."
              compact
            />
          ) : (
            <>
              <ActivityTimeline
                items={timeline.slice(0, 10).map((event) => ({
                  id: event.id,
                  title: event.title,
                  description: event.description,
                  timestamp: formatDate(event.date),
                  badge: event.badge,
                  tone: event.tone,
                  href: event.href,
                  icon: event.kind === "application" ? <Award className="h-3.5 w-3.5" /> : <CalendarDays className="h-3.5 w-3.5" />,
                  meta: event.kind === "application" ? "Recorded from the application pipeline" : "Recorded from advising history",
                }))}
              />
              {timeline.length > 10 ? (
                <p className="mt-4 text-xs text-slate-400">Showing 10 of {timeline.length} events.</p>
              ) : null}
            </>
          )}
        </DetailSection>
      </div>
    </>
  );
}
