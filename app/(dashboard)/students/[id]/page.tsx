import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Mail, GraduationCap, Award } from "lucide-react";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

type Student = Database["public"]["Tables"]["student"]["Row"];
type Application = Database["public"]["Tables"]["application"]["Row"] & {
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

export default async function StudentDetailPage({ params }: StudentDetailPageProps) {
  const { id } = await params;
  const studentId = parseInt(id);

  if (isNaN(studentId)) {
    notFound();
  }

  const [student, applications] = await Promise.all([
    getStudent(studentId),
    getApplications(studentId),
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
                      <th className="pb-3 text-left font-medium text-slate-500">Stage</th>
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
      </div>
    </>
  );
}
