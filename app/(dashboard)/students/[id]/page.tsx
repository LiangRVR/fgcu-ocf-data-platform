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
} from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

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

  return (
    <>
      <PageHeader title={student.full_name} description={`Student ID: ${student.student_id}`}>
        <Link href="/students">
          <Button variant="outline" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Students
          </Button>
        </Link>
      </PageHeader>

      <div className="space-y-6">
        {/* Basic Information */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-slate-500">Full Name</label>
                <p className="mt-1 text-sm text-slate-900">{student.full_name}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Email</label>
                <div className="mt-1 flex items-center gap-2">
                  <Mail className="h-4 w-4 text-slate-400" />
                  <a
                    href={`mailto:${student.email}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    {student.email}
                  </a>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Student ID</label>
                <p className="mt-1 text-sm text-slate-900">{student.student_id}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Status</label>
                <div className="mt-1">
                  {student.is_ch_student ? (
                    <Badge className="border-green-200 bg-green-100 text-green-800 hover:bg-green-100">
                      CH Student
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-100"
                    >
                      Other
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Academic Information */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Academic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-slate-500">Major</label>
                <div className="mt-1 flex items-center gap-2">
                  <GraduationCap className="h-4 w-4 text-slate-400" />
                  <p className="text-sm text-slate-900">{student.major || "—"}</p>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Minor</label>
                <p className="mt-1 text-sm text-slate-900">{student.minor || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Class Standing</label>
                <p className="mt-1 text-sm text-slate-900">{student.class_standing || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">GPA</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.gpa ? student.gpa.toFixed(2) : "—"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Honors College</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.honors_college ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Languages</label>
                <p className="mt-1 text-sm text-slate-900">{student.languages || "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Personal Information */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Personal Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="text-sm font-medium text-slate-500">Age</label>
                <p className="mt-1 text-sm text-slate-900">{student.age || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Gender</label>
                <p className="mt-1 text-sm text-slate-900">{student.gender || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Pronouns</label>
                <p className="mt-1 text-sm text-slate-900">{student.pronouns || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">Race/Ethnicity</label>
                <p className="mt-1 text-sm text-slate-900">{student.race_ethnicity || "—"}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">First Generation</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.first_gen ? "Yes" : "No"}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-500">US Citizen</label>
                <p className="mt-1 text-sm text-slate-900">
                  {student.us_citizen ? "Yes" : "No"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Applications Section */}
        <Card className="border-gray-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">
              Applications
              {applications.length > 0 && (
                <span className="ml-2 text-sm font-normal text-slate-500">
                  ({applications.length})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {applications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <Award className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-sm text-slate-500">
                  No applications found for this student.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="pb-3 text-left font-medium text-slate-500">Fellowship</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Stage of Application</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Destination</th>
                      <th className="pb-3 text-left font-medium text-slate-500">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {applications.map((app) => (
                      <tr key={app.application_id} className="py-2">
                        <td className="py-3 pr-4 font-medium text-slate-900">
                          {app.fellowship?.fellowship_name ?? `Fellowship #${app.fellowship_id}`}
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
                            {app.is_semi_finalist && (
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
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <CalendarDays className="h-5 w-5 text-slate-400" />
              Advising Meetings
              {advisingMeetings.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({advisingMeetings.length})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {advisingMeetings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                  <MessageSquare className="h-8 w-8 text-gray-400" />
                </div>
                <p className="text-sm text-slate-500">No advising meetings on record.</p>
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
                          {new Date(meeting.meeting_date).toLocaleDateString()}
                        </td>
                        <td className="py-3 pr-4 text-slate-700">
                          {meeting.meeting_mode}
                        </td>
                        <td className="py-3 pr-4 text-slate-700">
                          {meeting.advisor?.advisor_name ?? "—"}
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
                  ({fellowshipThursday.filter((r) => r.attended).length} attended /{" "}
                  {fellowshipThursday.length} total)
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
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Trophy className="h-5 w-5 text-amber-500" />
              Scholarship History
              {scholarshipHistory.length > 0 && (
                <span className="text-sm font-normal text-slate-500">
                  ({scholarshipHistory.length} award{scholarshipHistory.length !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
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
                  <Badge
                    key={record.history_id}
                    className="border-amber-200 bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
                  >
                    <Trophy className="mr-1.5 h-3.5 w-3.5" />
                    {record.fellowship?.fellowship_name ?? `Fellowship #${record.fellowship_id}`}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
