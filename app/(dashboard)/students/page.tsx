import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { UserPlus, Search, Eye, Pencil, Trash2, Users, GraduationCap, FileText, Award } from "lucide-react";
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

/**
 * Calculate dashboard statistics
 */
function getStatistics(students: Student[]) {
  const totalStudents = students.length;
  const chStudents = students.filter((s) => s.is_ch_student).length;

  return {
    totalStudents,
    chStudents,
    activeApplications: 0, // TODO: Calculate from applications table
    fellowshipsAvailable: 0, // TODO: Calculate from fellowships table
  };
}

export default async function StudentsPage() {
  const students = await getStudents();
  const stats = getStatistics(students);

  return (
    <>
      <PageHeader
        title="Students"
        description="Manage fellowship-eligible students"
      >
        <Button size="sm" className="bg-[#006747] hover:bg-[#00563b]">
          <UserPlus className="mr-2 h-4 w-4" />
          Add Student
        </Button>
      </PageHeader>

      {/* Statistics Cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                <Users className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{stats.totalStudents}</div>
                <div className="text-sm text-slate-500">Total Students</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                <GraduationCap className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{stats.chStudents}</div>
                <div className="text-sm text-slate-500">CH Students</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
                <FileText className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{stats.activeApplications}</div>
                <div className="text-sm text-slate-500">Active Applications</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                <Award className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <div className="text-2xl font-semibold text-slate-900">{stats.fellowshipsAvailable}</div>
                <div className="text-sm text-slate-500">Fellowships Available</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filter Bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="Search students..."
            className="pl-9"
          />
        </div>
        <div className="flex gap-2">
          {/* TODO: Add filter dropdown */}
        </div>
      </div>

      {/* Students Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {students.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <Users className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">No students found</h3>
              <p className="mb-4 text-sm text-slate-500">Get started by adding your first student.</p>
              <Button className="bg-[#006747] hover:bg-[#00563b]">
                <UserPlus className="mr-2 h-4 w-4" />
                Add Student
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Email</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Student ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Major</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Status</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {students.map((student) => (
                    <tr
                      key={student.student_id}
                      className="cursor-pointer transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="font-medium text-slate-900">{student.full_name}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">{student.email}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">{student.student_id}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">{student.major || "—"}</div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {student.is_ch_student ? (
                          <Badge
                            variant="default"
                            className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-100"
                          >
                            CH Student
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
                          >
                            Other
                          </Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="View student"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit student"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete student"
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
      {students.length > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm text-slate-500">
            Showing <span className="font-medium">1</span>–<span className="font-medium">{students.length}</span> of{" "}
            <span className="font-medium">{students.length}</span> students
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
