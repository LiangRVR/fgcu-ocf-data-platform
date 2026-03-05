import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilePlus } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Applications" };

type Application = Database["public"]["Tables"]["application"]["Row"] & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
};

/**
 * Fetch all applications with related student and fellowship data
 */
async function getApplications(): Promise<Application[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("application")
      .select(
        `
        *,
        student(full_name),
        fellowship(fellowship_name)
      `
      )
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

export default async function ApplicationsPage() {
  const applications = await getApplications();

  return (
    <>
      <PageHeader
        title="Applications"
        description="Track student fellowship applications and statuses."
      >
        <Button size="sm">
          <FilePlus className="mr-2 h-4 w-4" />
          New Application
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All Applications ({applications.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No applications found. Create your first application to get
              started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="pb-3 text-left font-medium">Student</th>
                    <th className="pb-3 text-left font-medium">Fellowship</th>
                    <th className="pb-3 text-left font-medium">Stage</th>
                    <th className="pb-3 text-left font-medium">Semifinalist</th>
                    <th className="pb-3 text-left font-medium">Finalist</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((application) => (
                    <tr
                      key={application.application_id}
                      className="border-b last:border-0"
                    >
                      <td className="py-3 font-medium">
                        {application.student?.full_name || "—"}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {application.fellowship?.fellowship_name || "—"}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {application.stage_of_application}
                      </td>
                      <td className="py-3">
                        <Badge variant={application.is_semi_finalist ? "default" : "secondary"}>
                          {application.is_semi_finalist ? "Yes" : "No"}
                        </Badge>
                      </td>
                      <td className="py-3">
                        <Badge variant={application.is_finalist ? "default" : "secondary"}>
                          {application.is_finalist ? "Yes" : "No"}
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
