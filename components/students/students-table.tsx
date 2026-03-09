"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import {
  Search,
  Eye,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  UserPlus,
  FileDown,
} from "lucide-react";
import { toast } from "sonner";
import type { Database } from "@/types/database";

type Student = Database["public"]["Tables"]["student"]["Row"];

type SortField = "full_name" | "student_id" | "major" | "gpa" | "class_standing";
type SortDirection = "asc" | "desc" | null;

interface StudentsTableProps {
  initialStudents: Student[];
}

export function StudentsTable({ initialStudents }: StudentsTableProps) {
  const router = useRouter();

  // State
  const [students, setStudents] = useState<Student[]>(initialStudents);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [majorFilter, setMajorFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [deleteStudentId, setDeleteStudentId] = useState<number | null>(null);
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Form state for add student
  const [newStudent, setNewStudent] = useState({
    full_name: "",
    email: "",
    student_id: "",
    major: "",
    class_standing: "",
    gpa: "",
    is_ch_student: false,
    first_gen: false,
    honors_college: false,
    us_citizen: false,
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(1); // Reset to first page on search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Get unique majors for filter
  const uniqueMajors = useMemo(() => {
    const majors = new Set(
      students.map((s) => s.major).filter((m): m is string => !!m)
    );
    return Array.from(majors).sort();
  }, [students]);

  // Filter and sort students
  const filteredAndSortedStudents = useMemo(() => {
    let filtered = students;

    // Search filter
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.full_name.toLowerCase().includes(query) ||
          s.email.toLowerCase().includes(query) ||
          String(s.student_id).includes(query)
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter((s) =>
        statusFilter === "ch" ? s.is_ch_student : !s.is_ch_student
      );
    }

    // Major filter
    if (majorFilter !== "all") {
      filtered = filtered.filter((s) => s.major === majorFilter);
    }

    // Sort
    if (sortField && sortDirection) {
      filtered = [...filtered].sort((a, b) => {
        let aVal = a[sortField];
        let bVal = b[sortField];

        // Handle null values
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

        // Convert to comparable values
        if (typeof aVal === "string") aVal = aVal.toLowerCase();
        if (typeof bVal === "string") bVal = bVal.toLowerCase();

        if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
        if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [
    students,
    debouncedSearch,
    statusFilter,
    majorFilter,
    sortField,
    sortDirection,
  ]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedStudents.length / pageSize);
  const paginatedStudents = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredAndSortedStudents.slice(start, start + pageSize);
  }, [filteredAndSortedStudents, currentPage, pageSize]);

  const startIndex = (currentPage - 1) * pageSize + 1;
  const endIndex = Math.min(
    currentPage * pageSize,
    filteredAndSortedStudents.length
  );

  // Handlers
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cycle through: asc -> desc -> null
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else if (sortDirection === "desc") {
        setSortField(null);
        setSortDirection(null);
      }
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleRowClick = (studentId: number) => {
    router.push(`/students/${studentId}`);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteStudentId) return;

    setIsLoading(true);
    try {
      // TODO: Implement actual delete API call
      // For now, just remove from local state
      setStudents((prev) => prev.filter((s) => s.student_id !== deleteStudentId));
      toast.success("Student deleted successfully");
    } catch {
      toast.error("Failed to delete student");
    } finally {
      setIsLoading(false);
      setDeleteStudentId(null);
    }
  };

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!newStudent.full_name.trim()) {
      errors.full_name = "Name is required";
    }

    if (!newStudent.email.trim()) {
      errors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newStudent.email)) {
      errors.email = "Invalid email format";
    }

    if (!newStudent.student_id.trim()) {
      errors.student_id = "Student ID is required";
    } else if (!/^\d+$/.test(newStudent.student_id)) {
      errors.student_id = "Student ID must be numeric";
    }

    if (newStudent.gpa.trim()) {
      const gpaNum = parseFloat(newStudent.gpa);
      if (isNaN(gpaNum) || gpaNum < 0 || gpaNum > 4.0) {
        errors.gpa = "GPA must be a number between 0.0 and 4.0";
      }
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleAddStudent = async () => {
    if (!validateForm()) return;

    setIsLoading(true);
    try {
      // TODO: Implement actual create API call
      // For now, add to local state with mock ID
      const newId = Math.max(...students.map((s) => s.student_id), 0) + 1;
      const student: Student = {
        student_id: newId,
        full_name: newStudent.full_name,
        email: newStudent.email,
        major: newStudent.major || null,
        class_standing: newStudent.class_standing || null,
        gpa: newStudent.gpa ? parseFloat(newStudent.gpa) : null,
        is_ch_student: newStudent.is_ch_student,
        first_gen: newStudent.first_gen,
        honors_college: newStudent.honors_college,
        us_citizen: newStudent.us_citizen,
        age: null,
        gender: null,
        languages: null,
        minor: null,
        pronouns: null,
        race_ethnicity: null,
      };

      setStudents((prev) => [student, ...prev]);
      toast.success("Student added successfully");
      setAddStudentOpen(false);
      setNewStudent({
        full_name: "",
        email: "",
        student_id: "",
        major: "",
        class_standing: "",
        gpa: "",
        is_ch_student: false,
        first_gen: false,
        honors_college: false,
        us_citizen: false,
      });
      setFormErrors({});
    } catch {
      toast.error("Failed to add student");
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearFilters = () => {
    setSearchQuery("");
    setDebouncedSearch("");
    setStatusFilter("all");
    setMajorFilter("all");
    setSortField(null);
    setSortDirection(null);
    setCurrentPage(1);
  };

  const handleExport = () => {
    // TODO: Implement CSV export
    toast.info("Export functionality coming soon");
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="ml-1 h-3.5 w-3.5" />;
    }
    return sortDirection === "asc" ? (
      <ChevronUp className="ml-1 h-3.5 w-3.5" />
    ) : (
      <ChevronDown className="ml-1 h-3.5 w-3.5" />
    );
  };

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Control Bar */}
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              {/* Left: Search and Filters */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative w-full sm:w-80">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="Search students by name, email, or ID…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>

                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="ch">CH Student</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={majorFilter} onValueChange={setMajorFilter}>
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder="All majors" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All majors</SelectItem>
                    {uniqueMajors.map((major) => (
                      <SelectItem key={major} value={major}>
                        {major}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Right: Actions */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  className="gap-2"
                >
                  <FileDown className="h-4 w-4" />
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  onClick={() => setAddStudentOpen(true)}
                  className="bg-[#006747] hover:bg-[#00563b]"
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Student
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Students Table */}
        <Card className="border-gray-200 shadow-sm">
          <CardContent className="p-0">
            {filteredAndSortedStudents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                  <Search className="h-10 w-10 text-gray-400" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900">
                  No students found
                </h3>
                <p className="mb-4 text-sm text-slate-500">
                  {debouncedSearch || statusFilter !== "all" || majorFilter !== "all"
                    ? "Try adjusting your filters or search query."
                    : "Get started by adding your first student."}
                </p>
                {(debouncedSearch || statusFilter !== "all" || majorFilter !== "all") && (
                  <Button variant="outline" onClick={handleClearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr className="border-b border-gray-200">
                        <th
                          onClick={() => handleSort("full_name")}
                          className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900"
                        >
                          <div className="flex items-center">
                            Name
                            <SortIcon field="full_name" />
                          </div>
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600">
                          Email
                        </th>
                        <th
                          onClick={() => handleSort("student_id")}
                          className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900"
                        >
                          <div className="flex items-center">
                            Student ID
                            <SortIcon field="student_id" />
                          </div>
                        </th>
                        <th
                          onClick={() => handleSort("major")}
                          className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900"
                        >
                          <div className="flex items-center">
                            Major
                            <SortIcon field="major" />
                          </div>
                        </th>
                        <th
                          onClick={() => handleSort("gpa")}
                          className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900"
                        >
                          <div className="flex items-center">
                            GPA
                            <SortIcon field="gpa" />
                          </div>
                        </th>
                        <th
                          onClick={() => handleSort("class_standing")}
                          className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900"
                        >
                          <div className="flex items-center">
                            Class Standing
                            <SortIcon field="class_standing" />
                          </div>
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-600">
                          Tags
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-600">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {paginatedStudents.map((student) => (
                        <tr
                          key={student.student_id}
                          onClick={() => handleRowClick(student.student_id)}
                          className="cursor-pointer transition-colors duration-150 hover:bg-gray-50"
                        >
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="font-medium text-slate-900">
                              {student.full_name}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="max-w-xs truncate text-sm text-slate-600">
                              {student.email}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="text-sm text-slate-600">
                              {student.student_id}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="text-sm text-slate-600">
                              {student.major || "—"}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="text-sm text-slate-600">
                              {student.gpa != null ? student.gpa.toFixed(2) : "—"}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="text-sm text-slate-600">
                              {student.class_standing || "—"}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="flex flex-wrap gap-1">
                              {student.is_ch_student && (
                                <Badge className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-100">
                                  CH
                                </Badge>
                              )}
                              {student.first_gen && (
                                <Badge className="rounded-full border border-teal-200 bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 hover:bg-teal-100">
                                  First Gen
                                </Badge>
                              )}
                              {student.honors_college && (
                                <Badge className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100">
                                  Honors
                                </Badge>
                              )}
                              {!student.is_ch_student && !student.first_gen && !student.honors_college && (
                                <span className="text-sm text-slate-400">—</span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-6 py-4">
                            <div className="flex items-center justify-end gap-1">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRowClick(student.student_id);
                                    }}
                                    className="h-8 w-8 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                  >
                                    <Eye className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>View student</p>
                                </TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toast.info("Edit functionality coming soon");
                                    }}
                                    className="h-8 w-8 text-slate-500 hover:bg-blue-50 hover:text-blue-600"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Edit student</p>
                                </TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteStudentId(student.student_id);
                                    }}
                                    className="h-8 w-8 text-slate-500 hover:bg-red-50 hover:text-red-600"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Delete student</p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div className="flex items-center justify-between border-t border-gray-200 bg-white px-6 py-4">
                  <div className="flex items-center gap-4">
                    <p className="text-sm text-slate-600">
                      Showing {startIndex}–{endIndex} of{" "}
                      {filteredAndSortedStudents.length} students
                    </p>
                    <Select
                      value={String(pageSize)}
                      onValueChange={(v) => {
                        setPageSize(Number(v));
                        setCurrentPage(1);
                      }}
                    >
                      <SelectTrigger className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10 / page</SelectItem>
                        <SelectItem value="20">20 / page</SelectItem>
                        <SelectItem value="50">50 / page</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </Button>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        let pageNum: number;
                        if (totalPages <= 5) {
                          pageNum = i + 1;
                        } else if (currentPage <= 3) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 2) {
                          pageNum = totalPages - 4 + i;
                        } else {
                          pageNum = currentPage - 2 + i;
                        }

                        return (
                          <Button
                            key={pageNum}
                            variant={currentPage === pageNum ? "default" : "outline"}
                            size="sm"
                            onClick={() => setCurrentPage(pageNum)}
                            className={
                              currentPage === pageNum
                                ? "bg-[#006747] hover:bg-[#00563b]"
                                : ""
                            }
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setCurrentPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={currentPage === totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add Student Dialog */}
      <Dialog open={addStudentOpen} onOpenChange={setAddStudentOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Student</DialogTitle>
            <DialogDescription>
              Enter the student information below. All fields marked with * are
              required.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="full_name">
                Full Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="full_name"
                value={newStudent.full_name}
                onChange={(e) =>
                  setNewStudent({ ...newStudent, full_name: e.target.value })
                }
                placeholder="John Doe"
              />
              {formErrors.full_name && (
                <p className="text-sm text-red-600">{formErrors.full_name}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">
                Email <span className="text-red-500">*</span>
              </Label>
              <Input
                id="email"
                type="email"
                value={newStudent.email}
                onChange={(e) =>
                  setNewStudent({ ...newStudent, email: e.target.value })
                }
                placeholder="john.doe@fgcu.edu"
              />
              {formErrors.email && (
                <p className="text-sm text-red-600">{formErrors.email}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="student_id">
                Student ID <span className="text-red-500">*</span>
              </Label>
              <Input
                id="student_id"
                value={newStudent.student_id}
                onChange={(e) =>
                  setNewStudent({ ...newStudent, student_id: e.target.value })
                }
                placeholder="12345678"
              />
              {formErrors.student_id && (
                <p className="text-sm text-red-600">{formErrors.student_id}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="major">Major</Label>
              <Input
                id="major"
                value={newStudent.major}
                onChange={(e) =>
                  setNewStudent({ ...newStudent, major: e.target.value })
                }
                placeholder="Computer Science"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="class_standing">Class Standing</Label>
                <Select
                  value={newStudent.class_standing}
                  onValueChange={(v) =>
                    setNewStudent({ ...newStudent, class_standing: v })
                  }
                >
                  <SelectTrigger id="class_standing">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Freshman">Freshman</SelectItem>
                    <SelectItem value="Sophomore">Sophomore</SelectItem>
                    <SelectItem value="Junior">Junior</SelectItem>
                    <SelectItem value="Senior">Senior</SelectItem>
                    <SelectItem value="Graduate">Graduate</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="gpa">GPA</Label>
                <Input
                  id="gpa"
                  type="number"
                  step="0.01"
                  min="0"
                  max="4.0"
                  value={newStudent.gpa}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, gpa: e.target.value })
                  }
                  placeholder="3.75"
                />
                {formErrors.gpa && (
                  <p className="text-sm text-red-600">{formErrors.gpa}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_ch_student"
                  checked={newStudent.is_ch_student}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, is_ch_student: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <Label htmlFor="is_ch_student" className="cursor-pointer">
                  CH Student
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="first_gen"
                  checked={newStudent.first_gen}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, first_gen: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <Label htmlFor="first_gen" className="cursor-pointer">
                  First Generation
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="honors_college"
                  checked={newStudent.honors_college}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, honors_college: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <Label htmlFor="honors_college" className="cursor-pointer">
                  Honors College
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="us_citizen"
                  checked={newStudent.us_citizen}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, us_citizen: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <Label htmlFor="us_citizen" className="cursor-pointer">
                  US Citizen
                </Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddStudentOpen(false);
                setNewStudent({
                  full_name: "",
                  email: "",
                  student_id: "",
                  major: "",
                  class_standing: "",
                  gpa: "",
                  is_ch_student: false,
                  first_gen: false,
                  honors_college: false,
                  us_citizen: false,
                });
                setFormErrors({});
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddStudent}
              disabled={isLoading}
              className="bg-[#006747] hover:bg-[#00563b]"
            >
              {isLoading ? "Creating..." : "Create Student"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteStudentId !== null}
        onOpenChange={(open) => !open && setDeleteStudentId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete student?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the student record and related references (if
              applicable). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
