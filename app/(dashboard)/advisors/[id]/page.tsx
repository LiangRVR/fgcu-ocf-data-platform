import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-section";
import { EmptyState } from "@/components/ui/empty-state";
import { EntityHeader } from "@/components/ui/entity-header";
import { MetricBadge } from "@/components/ui/metric-badge";
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
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
      <EntityHeader
        kicker="Advisor Record"
        title={advisor.advisor_name}
        description={`Advisor ID ${advisor.advisor_id}${advisor.email ? ` • ${advisor.email}` : ""}`}
        badges={
          <>
            <MetricBadge tone={advisor.is_active ? "green" : "red"}>{advisor.is_active ? "Active" : "Inactive"}</MetricBadge>
            <MetricBadge tone="slate">{advisor.role}</MetricBadge>
          </>
        }
        actions={
          <>
            <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
              <Button size="sm">
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
          </>
        }
        summary={
          <>
            {[
              { label: "Total Meetings", value: meetings.length },
              { label: "Students Advised", value: uniqueStudentCount },
              { label: "No-Shows", value: noShowCount },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-border/70 bg-surface-subtle px-4 py-3">
                <p className="text-xs uppercase tracking-[0.16em] text-slate-400">{item.label}</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{item.value}</p>
              </div>
            ))}
          </>
        }
      />

      <DetailSection
        title="Advising Meetings"
        description="Recent meeting history for this advisor, including attendance and note coverage."
        icon={<CalendarDays className="h-5 w-5" />}
        actions={
          <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
            <Button size="sm" variant="outline" className="h-8 text-xs">
              <CalendarPlus className="mr-2 h-4 w-4" />
              Log Meeting
            </Button>
          </Link>
        }
      >
          {meetings.length === 0 ? (
            <EmptyState
              icon={User}
              title="No meetings recorded"
              description="No advising sessions are attached to this advisor yet."
              compact
              action={
                <Link href={`/advising?add=1&advisor_id=${advisor.advisor_id}`}>
                  <Button size="sm">
                    <CalendarPlus className="mr-2 h-4 w-4" />
                    Log First Meeting
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                {meetings.map((meeting) => (
                  <div key={meeting.meeting_id} className="rounded-2xl border border-border/70 bg-surface-subtle/70 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={`/students/${meeting.student_id}`}
                        className="min-w-0 text-sm font-semibold text-slate-900 hover:text-primary hover:underline"
                      >
                        <span className="line-clamp-2">{meeting.student?.full_name ?? `Student #${meeting.student_id}`}</span>
                      </Link>
                      <MetricBadge tone={meeting.no_show ? "red" : "green"}>
                        {meeting.no_show ? "No-Show" : "Attended"}
                      </MetricBadge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                        {meeting.meeting_mode}
                      </MetricBadge>
                      <MetricBadge tone="slate">
                        {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </MetricBadge>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-500">
                      {meeting.notes || "No notes recorded yet."}
                    </p>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto md:block">
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
                        <MetricBadge tone={meeting.meeting_mode === "Virtual" ? "blue" : "slate"}>
                          {meeting.meeting_mode}
                        </MetricBadge>
                      </td>
                      <td className="px-4 py-3">
                        {meeting.no_show ? (
                          <MetricBadge tone="red">No-Show</MetricBadge>
                        ) : (
                          <MetricBadge tone="green">Attended</MetricBadge>
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
            </>
          )}
      </DetailSection>
    </>
  );
}
