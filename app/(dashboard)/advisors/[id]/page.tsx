import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Users,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  XCircle,
  User,
} from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

type Advisor = Database["public"]["Tables"]["advisor"]["Row"];
type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { student_id: number; full_name: string } | null;
};

interface AdvisorDetailPageProps {
  params: Promise<{ id: string }>;
}

async function getAdvisor(id: number): Promise<Advisor | null> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("advisor")
      .select("*")
      .eq("advisor_id", id)
      .single();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

async function getMeetings(advisorId: number): Promise<AdvisingMeeting[]> {
  const supabase = createServerClient();
  try {
    const { data, error } = await supabase
      .from("advising_meeting")
      .select("*, student(student_id, full_name)")
      .eq("advisor_id", advisorId)
      .order("meeting_date", { ascending: false });
    if (error) return [];
    return (data as AdvisingMeeting[]) || [];
  } catch {
    return [];
  }
}

export default async function AdvisorDetailPage({ params }: AdvisorDetailPageProps) {
  const { id } = await params;
  const advisorId = parseInt(id);

  if (isNaN(advisorId)) {
    notFound();
  }

  const [advisor, meetings] = await Promise.all([
    getAdvisor(advisorId),
    getMeetings(advisorId),
  ]);

  if (!advisor) {
    notFound();
  }

  const noShowCount = meetings.filter((m) => m.no_show).length;
  const uniqueStudentIds = new Set(meetings.map((m) => m.student_id));
  const uniqueStudentCount = uniqueStudentIds.size;

  return (
    <>
      <PageHeader
        title={advisor.advisor_name}
        description={`Advisor ID: ${advisor.advisor_id}`}
      >
        <div className="flex items-center gap-2">
          <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
            <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
              <CalendarPlus className="mr-2 h-4 w-4" />
              Log Meeting
            </Button>
          </Link>
          <Link href="/advising">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Advising
            </Button>
          </Link>
        </div>
      </PageHeader>

      {/* Summary stat strip */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {[
          { label: "Total Meetings", value: meetings.length, icon: CalendarDays, color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Students Advised", value: uniqueStudentCount, icon: Users, color: "text-purple-600", bg: "bg-purple-50" },
          { label: "No-Shows", value: noShowCount, icon: XCircle, color: "text-red-500", bg: "bg-red-50" },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <Card key={label} className="border-gray-200 shadow-sm">
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{value}</div>
                <div className="text-xs text-slate-500">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Meetings Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="h-5 w-5 text-slate-400" />
            Advising Meetings
            {meetings.length > 0 && (
              <span className="text-sm font-normal text-slate-500">
                ({meetings.length})
              </span>
            )}
          </CardTitle>
          <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
            <Button size="sm" variant="outline" className="h-8 text-xs">
              <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
              Log Meeting
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
                <User className="h-8 w-8 text-gray-400" />
              </div>
              <p className="mb-3 text-sm text-slate-500">No meetings recorded for this advisor.</p>
              <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
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
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Student
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Mode
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Attended
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {meetings.map((meeting) => (
                    <tr key={meeting.meeting_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">
                        <Link
                          href={`/students/${meeting.student_id}`}
                          className="text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {meeting.student?.full_name ?? `Student #${meeting.student_id}`}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                          "en-US",
                          { year: "numeric", month: "short", day: "numeric" }
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="secondary"
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            meeting.meeting_mode === "Virtual"
                              ? "border-blue-200 bg-blue-100 text-blue-800"
                              : "border-slate-200 bg-slate-100 text-slate-700"
                          }`}
                        >
                          {meeting.meeting_mode}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
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
                      <td className="max-w-xs px-4 py-3 text-slate-500">
                        {meeting.notes || <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
