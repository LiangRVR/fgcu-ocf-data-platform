import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };

type Fellowship = Database["public"]["Tables"]["fellowship"]["Row"];

/**
 * Fetch all fellowships from the database
 */
async function getFellowships(): Promise<Fellowship[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("fellowship")
      .select("*")
      .order("fellowship_id", { ascending: false });

    if (error) {
      console.error("Error fetching fellowships:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error fetching fellowships:", error);
    return [];
  }
}

export default async function FellowshipsPage() {
  const fellowships = await getFellowships();

  return (
    <>
      <PageHeader
        title="Fellowships"
        description="Browse and manage available fellowship opportunities."
      >
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Fellowship
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All Fellowships ({fellowships.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {fellowships.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No fellowships found. Add your first fellowship opportunity to get
              started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="pb-3 text-left font-medium">Name</th>
                    <th className="pb-3 text-left font-medium">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {fellowships.map((fellowship) => (
                    <tr key={fellowship.fellowship_id} className="border-b last:border-0">
                      <td className="py-3 font-medium">{fellowship.fellowship_name}</td>
                      <td className="py-3 text-muted-foreground">
                        {fellowship.fellowship_id}
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
