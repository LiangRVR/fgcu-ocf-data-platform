import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UserPlus } from "lucide-react";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Students" };

type Student = Database["public"]["Tables"]["student"]["Row"];

/**
 * Fetch all students from the database
 */
async function getStudents(): Promise<Student[]> {
  const supabase = createServerClient();

  try {
    const { data, error } = await supabase
      .from("student")
      .select("*")
      .order("student_id", { ascending: false });

    if (error) {
      console.error("Error fetching students:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error fetching students:", error);
    return [];
  }
}

export default async function StudentsPage() {
  const students = await getStudents();

  return (
    <>
      <PageHeader
        title="Students"
        description="Manage fellowship-eligible students."
      >
        <Button size="sm">
          <UserPlus className="mr-2 h-4 w-4" />
          Add Student
        </Button>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All Students ({students.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {students.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No students found. Add your first student to get started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="pb-3 text-left font-medium">Name</th>
                    <th className="pb-3 text-left font-medium">Email</th>
                    <th className="pb-3 text-left font-medium">Student ID</th>
                    <th className="pb-3 text-left font-medium">Major</th>
                    <th className="pb-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((student) => (
                    <tr key={student.student_id} className="border-b last:border-0">
                      <td className="py-3">
                        {student.full_name}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {student.email}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {student.student_id}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {student.major || "—"}
                      </td>
                      <td className="py-3">
                        <Badge
                          variant={
                            student.is_ch_student ? "default" : "secondary"
                          }
                        >
                          {student.is_ch_student ? "CH Student" : "Other"}
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
