import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CalendarPlus } from "lucide-react";
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
        description="Schedule and track advising meetings with students."
      >
        <Button size="sm">
          <CalendarPlus className="mr-2 h-4 w-4" />
          Schedule Meeting
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All Advising Meetings ({meetings.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No advising meetings found. Schedule your first meeting to get
              started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="pb-3 text-left font-medium">Student</th>
                    <th className="pb-3 text-left font-medium">Advisor</th>
                    <th className="pb-3 text-left font-medium">Meeting Date</th>
                    <th className="pb-3 text-left font-medium">Mode</th>
                    <th className="pb-3 text-left font-medium">No Show</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((meeting) => (
                    <tr key={meeting.meeting_id} className="border-b last:border-0">
                      <td className="py-3 font-medium">
                        {meeting.student?.full_name || "—"}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {meeting.advisor?.advisor_name || "—"}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {new Date(meeting.meeting_date).toLocaleString()}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {meeting.meeting_mode}
                      </td>
                      <td className="py-3">
                        <Badge variant={meeting.no_show ? "destructive" : "default"}>
                          {meeting.no_show ? "Yes" : "No"}
                        </Badge>
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
