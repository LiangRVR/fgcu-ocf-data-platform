import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CalendarPlus, Search, Eye, Pencil, Trash2, Calendar } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Advising" };

type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { full_name: string } | null;
  advisor: { advisor_name: string } | null;
};

/**
 * Fetch all advising meetings with related student and advisor data
 */
async function getAdvisingMeetings(): Promise<AdvisingMeeting[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("advising_meeting")
      .select(
        `
        *,
        student(full_name),
        advisor(advisor_name)
      `
      )
      .order("meeting_date", { ascending: false });

    if (error) {
      console.error("Error fetching advising meetings:", error);
      return [];
    }

    return (data as AdvisingMeeting[]) || [];
  } catch (error) {
    console.error("Error fetching advising meetings:", error);
    return [];
  }
}

export default async function AdvisingPage() {
  const meetings = await getAdvisingMeetings();

  return (
    <>
      <PageHeader
        title="Advising"
        description="Schedule and track advising meetings with students"
      >
        <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
          <CalendarPlus className="mr-2 h-4 w-4" />
          Schedule Meeting
        </Button>
      </PageHeader>

      {/* Search Bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search meetings..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Advising Meetings Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <Calendar className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">No meetings found</h3>
              <p className="mb-4 text-sm text-slate-500">Get started by scheduling your first advising meeting.</p>
              <Button className="bg-[#006747] hover:bg-[#00563b]">
                <CalendarPlus className="mr-2 h-4 w-4" />
                Schedule Meeting
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Student</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Advisor</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Meeting Date</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Mode</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">No Show</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {meetings.map((meeting) => (
                    <tr
                      key={meeting.meeting_id}
                      className="cursor-pointer transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="font-medium text-slate-900">
                          {meeting.student?.full_name || "—"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">
                          {meeting.advisor?.advisor_name || "—"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">
                          {new Date(meeting.meeting_date).toLocaleString()}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">
                          {meeting.meeting_mode}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {meeting.no_show ? (
                          <Badge
                            variant="destructive"
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                          >
                            Yes
                          </Badge>
                        ) : (
                          <Badge
                            variant="default"
                            className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-100"
                          >
                            No
                          </Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="View meeting"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit meeting"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete meeting"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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

      {/* Pagination */}
      {meetings.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-slate-500">
            Showing <span className="font-medium">1</span>–<span className="font-medium">{meetings.length}</span> of{" "}
            <span className="font-medium">{meetings.length}</span> meetings
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
