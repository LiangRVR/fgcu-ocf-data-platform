import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  Star,
  Activity,
} from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import { StudentInfoEditor } from "@/components/students/student-info-editor";

type Student = Database["public"]["Tables"]["student"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"] & {
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
      .order("application_id", { ascending: false });

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
  type TimelineEvent =
    | { kind: "application"; date: string; label: string; sub: string; href: string }
    | { kind: "meeting"; date: string; label: string; sub: string; href: string };

  const timeline: TimelineEvent[] = [
    ...applications.map((a) => ({
      kind: "application" as const,
      date: String(a.application_id), // no date column; use id for ordering
      label: a.fellowship?.fellowship_name ?? `Fellowship #${a.fellowship_id}`,
      sub: a.stage_of_application,
      href: `/fellowships/${a.fellowship_id}`,
    })),
    ...advisingMeetings.map((m) => ({
      kind: "meeting" as const,
      date: m.meeting_date,
      label: m.meeting_date,
      sub: `${m.meeting_mode}${m.no_show ? " · No-Show" : ""}${m.advisor ? ` · ${m.advisor.advisor_name}` : ""}`,
      href: m.advisor_id ? `/advisors/${m.advisor_id}` : "/advising",
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <>
      <PageHeader title={student.full_name} description={`Student ID: ${student.student_id}`}>
        <div className="flex items-center gap-2">
          <Link href={`/applications?add=1&student_id=${student.student_id}`}>
            <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
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
        </div>
      </PageHeader>

      {/* Summary stat strip */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Applications", value: applications.length, icon: Award, color: "text-purple-600", bg: "bg-purple-50" },
          { label: "Finalists", value: finalistCount, icon: Star, color: "text-green-600", bg: "bg-green-50" },
          { label: "Meetings", value: advisingMeetings.length, icon: CalendarDays, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "No-Shows", value: noShowCount, icon: XCircle, color: "text-red-500", bg: "bg-red-50" },
          { label: "FT Attended", value: ftAttended, icon: CheckCircle2, color: "text-teal-600", bg: "bg-teal-50" },
          { label: "Scholarships", value: scholarshipHistory.length, icon: Trophy, color: "text-amber-600", bg: "bg-amber-50" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="border-gray-200 shadow-sm">
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              <div>
                <div className="text-xl font-semibold text-slate-900">{value}</div>
                <div className="text-xs text-slate-500">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Fellowship</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Stage</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Destination</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Status</th>
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
                        <td className="py-3 pr-4 text-slate-700">
                          {app.destination_country || "—"}
                        </td>
                        <td className="py-3">
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Date</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Mode</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Advisor</th>
                      <th className="pb-3 text-left font-medium text-slate-500">No-Show</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Notes</th>
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
                        <td className="py-3 pr-4 text-slate-700">
                          {meeting.meeting_mode}
                        </td>
                        <td className="py-3 pr-4">
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
                        <td className="max-w-xs py-3 text-slate-600">
                          {meeting.notes || <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Fellowship Thursday Attendance */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarDays className="h-5 w-5 text-slate-400" />
              Fellowship Thursday
              {fellowshipThursday.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({ftAttended} attended / {fellowshipThursday.length} total)
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {fellowshipThursday.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <CalendarDays className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-sm text-slate-500">No Fellowship Thursday records.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
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

        {/* Activity Timeline */}
        {timeline.length > 0 && (
          <Card className="border-gray-200 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Activity className="h-5 w-5 text-slate-400" />
                Activity Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative border-l border-gray-200">
                {timeline.slice(0, 10).map((event, idx) => (
                  <li key={idx} className="mb-4 ml-4">
                    <div className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-gray-300" />
                    <div className="flex items-start justify-between">
                      <div>
                        <Link
                          href={event.href}
                          className="text-sm font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {event.label}
                        </Link>
                        <p className="text-xs text-slate-500">{event.sub}</p>
                      </div>
                      <Badge
                        variant="secondary"
                        className={`ml-3 shrink-0 text-xs ${
                          event.kind === "application"
                            ? "border-purple-200 bg-purple-50 text-purple-700"
                            : "border-blue-200 bg-blue-50 text-blue-700"
                        }`}
                      >
                        {event.kind === "application" ? "Application" : "Meeting"}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ol>
              {timeline.length > 10 && (
                <p className="mt-2 text-xs text-slate-400">
                  Showing 10 of {timeline.length} events
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
