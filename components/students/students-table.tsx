"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MetricBadge } from "@/components/ui/metric-badge";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Eye,
  Pencil,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  UserPlus,
  MoreHorizontal,
  SlidersHorizontal,
} from "lucide-react";
import { LifecycleAction } from "@/components/lifecycle";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import { Pagination } from "@/components/pagination/pagination";
import {
  DEFAULT_PAGE,
  updateListSearchParams,
  type ListQueryPatch,
} from "@/lib/utils/pagination";
import type { Database } from "@/types/database";

/** Explicit list row from the read-only `student_list` view. */
type Student = Database["public"]["Views"]["student_list"]["Row"];

/** Sort columns the server loader allowlists; mirrors the page loader. */
const SORT_FIELDS = ["full_name", "major", "gpa", "class_standing"] as const;
type SortField = (typeof SORT_FIELDS)[number];
type SortDirection = "asc" | "desc" | null;

interface StudentsTableProps {
  initialStudents: Student[];
  initialSearchQuery?: string;
  /**
   * When true, the table is rendering the explicit Archived Students filter
   * context: every row gets a Restore Student action (instead of the default
   * Archive Student action), and the destructive Delete control is omitted in
   * both modes. The default (false) renders Archive Student on active rows.
   */
  archiveView?: boolean;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const EMPTY_STUDENT_FORM = {
  full_name: "",
  email: "",
  major: "",
  minor: "",
  class_standing: "",
  gpa: "",
  age: "",
  gender: "",
  pronouns: "",
  languages: "",
  race_ethnicity: "",
  is_ch_student: false,
  first_gen: false,
  honors_college: false,
  us_citizen: false,
};

const CLASS_STANDINGS = [
  "Freshman",
  "Sophomore",
  "Junior",
  "Senior",
  "Graduate",
  "Doctoral",
] as const;

const GENDER_OPTIONS = [
  { value: "F",  label: "Female" },
  { value: "M",  label: "Male" },
  { value: "NB", label: "Non-binary" },
  { value: "NR", label: "Prefer not to say" },
] as const;

export function StudentsTable({
  initialStudents,
  initialSearchQuery,
  archiveView = false,
  totalCount,
  page,
  pageSize,
  totalPages,
}: StudentsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── URL is the single source of truth for list state ─────────────────────
  // The server loader filters/sorts/paginates; these controls only rewrite the
  // query string (search/filter/sort changes reset to page 1 via the shared
  // helper), preserving unrelated contextual parameters such as `view`.
  const navigateTo = (patch: {
    page?: number | string | null;
    pageSize?: number | string | null;
    search?: string | null;
    flag?: string | null;
    standing?: string | null;
    sort?: string | null;
    direction?: string | null;
  }) => {
    const shared: ListQueryPatch = {};
    if ("page" in patch) shared.page = patch.page;
    if ("pageSize" in patch) shared.pageSize = patch.pageSize;
    if ("search" in patch) shared.search = patch.search;
    if ("sort" in patch) shared.sort = patch.sort;
    const next = updateListSearchParams(searchParams.toString(), shared);

    let criterionChanged =
      patch.search !== undefined || patch.sort !== undefined || patch.pageSize !== undefined;

    if (patch.flag !== undefined) {
      criterionChanged = true;
      if (patch.flag === null || patch.flag === "all") next.delete("flag");
      else next.set("flag", patch.flag);
    }
    if (patch.standing !== undefined) {
      criterionChanged = true;
      if (patch.standing === null || patch.standing === "all") next.delete("standing");
      else next.set("standing", patch.standing);
    }
    if (patch.direction !== undefined) {
      criterionChanged = true;
      if (patch.direction === null) next.delete("direction");
      else next.set("direction", patch.direction);
    }

    if (criterionChanged) next.set("page", String(DEFAULT_PAGE));

    const query = next.toString();
    router.push(query ? `/students?${query}` : "/students");
  };

  const statusFilter = searchParams.get("flag") ?? "all";
  const standingFilter = searchParams.get("standing") ?? "all";
  const sortField: SortField | null = (SORT_FIELDS as readonly string[]).includes(
    searchParams.get("sort") ?? "",
  )
    ? (searchParams.get("sort") as SortField)
    : null;
  const sortDirection: SortDirection = sortField
    ? searchParams.get("direction") === "desc"
      ? "desc"
      : "asc"
    : null;

  // State
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearchQuery ?? "");
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [editStudentOpen, setEditStudentOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Form state for add student
  const [newStudent, setNewStudent] = useState(EMPTY_STUDENT_FORM);
  // Form state for edit student
  const [editForm, setEditForm] = useState(EMPTY_STUDENT_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [editFormErrors, setEditFormErrors] = useState<Record<string, string>>({});

  // Keep the local search input aligned with the committed URL state after a
  // navigation/refresh.
  useEffect(() => {
    setSearchQuery(initialSearchQuery ?? "");
    setDebouncedSearch(initialSearchQuery ?? "");
  }, [initialSearchQuery]);

  // Debounce search and commit it to canonical URL state (resets to page 1).
  // The guard makes the initial mount a no-op while the typed value already
  // matches the committed prop, so loading a URL-backed `?page=2` (or a
  // bookmarked `?search=…`) does not rewrite the query string and drop the
  // current page. Mirrors the Advising/Scholarship tables.
  useEffect(() => {
    if (searchQuery === (initialSearchQuery ?? "")) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      navigateTo({ search: searchQuery || null });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, initialSearchQuery]);

  // `students` are already filtered/sorted/paginated server-side.
  const students = initialStudents;
  const hasActiveCriteria =
    !!debouncedSearch || statusFilter !== "all" || standingFilter !== "all";

  // Handlers
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cycle through: asc -> desc -> cleared (server default student_id DESC)
      if (sortDirection === "asc") {
        navigateTo({ direction: "desc" });
      } else {
        navigateTo({ sort: null, direction: null });
      }
    } else {
      navigateTo({ sort: field, direction: "asc" });
    }
  };

  const handleClearFilters = () => {
    setSearchQuery("");
    setDebouncedSearch("");
    navigateTo({ search: null, flag: null, standing: null, sort: null, direction: null });
  };

  const handleRowClick = (studentId: number) => {
    router.push(`/students/${studentId}`);
  };

  const validateStudentForm = (
    data: typeof EMPTY_STUDENT_FORM,
  ): Record<string, string> => {
    const errors: Record<string, string> = {};

    if (!data.full_name.trim()) errors.full_name = "Name is required";

    if (!data.email.trim()) {
      errors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      errors.email = "Invalid email format";
    }

    if (data.age.trim()) {
      const ageNum = parseInt(data.age, 10);
      if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
        errors.age = "Age must be a valid number";
      }
    }

    if (data.gpa.trim()) {
      const gpaNum = parseFloat(data.gpa);
      if (isNaN(gpaNum) || gpaNum < 0 || gpaNum > 4.0) {
        errors.gpa = "GPA must be a number between 0.0 and 4.0";
      }
    }

    return errors;
  };

  const handleAddStudent = async () => {
    const errors = validateStudentForm(newStudent);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("student")
        .insert({
          full_name: newStudent.full_name,
          email: newStudent.email,
          major: newStudent.major || null,
          minor: newStudent.minor || null,
          class_standing: newStudent.class_standing || null,
          gpa: newStudent.gpa ? parseFloat(newStudent.gpa) : null,
          age: newStudent.age ? parseInt(newStudent.age, 10) : null,
          gender: newStudent.gender || null,
          pronouns: newStudent.pronouns || null,
          languages: newStudent.languages || null,
          race_ethnicity: newStudent.race_ethnicity || null,
          is_ch_student: newStudent.is_ch_student,
          first_gen: newStudent.first_gen,
          honors_college: newStudent.honors_college,
          us_citizen: newStudent.us_citizen,
        })
        .select()
        .single();

      if (error) throw error;

      // Re-run the server loader so the paged source reflects the new row
      // rather than patching a possibly partial page in memory.
      router.refresh();
      toast.success("Student added successfully");
      setAddStudentOpen(false);
      setNewStudent(EMPTY_STUDENT_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to add student");
    } finally {
      setIsLoading(false);
    }
  };

  const openEdit = (student: Student) => {
    setEditingStudent(student);
    setEditForm({
      ...EMPTY_STUDENT_FORM,
      full_name: student.full_name,
      email: student.email,
      major: student.major ?? "",
      class_standing: student.class_standing ?? "",
      gpa: student.gpa != null ? String(student.gpa) : "",
      is_ch_student: student.is_ch_student,
      first_gen: student.first_gen,
      honors_college: student.honors_college,
      us_citizen: student.us_citizen,
    });
    setEditFormErrors({});
    setEditStudentOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingStudent) return;
    const errors = validateStudentForm(editForm);
    setEditFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("student")
        .update({
          full_name: editForm.full_name,
          email: editForm.email,
          major: editForm.major || null,
          class_standing: editForm.class_standing || null,
          gpa: editForm.gpa ? parseFloat(editForm.gpa) : null,
          is_ch_student: editForm.is_ch_student,
          first_gen: editForm.first_gen,
          honors_college: editForm.honors_college,
          us_citizen: editForm.us_citizen,
        })
        .eq("student_id", editingStudent.student_id)
        .select()
        .single();

      if (error) throw error;

      // Re-run the server loader so the edited row's new sort position and
      // any filter membership are reflected on the current paged source.
      router.refresh();
      toast.success("Student updated successfully");
      setEditStudentOpen(false);
      setEditingStudent(null);
      setEditForm(EMPTY_STUDENT_FORM);
      setEditFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to update student");
    } finally {
      setIsLoading(false);
    }
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
        <DataToolbar
          leading={
            <>
              <div className="flex items-center gap-2">
                <div className="relative flex-1 sm:w-80">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    placeholder="Search students by name or email…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5 xl:hidden"
                  onClick={() => setFiltersOpen((o) => !o)}
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Filters
                  {(statusFilter !== "all" || standingFilter !== "all") && (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">•</span>
                  )}
                </Button>
              </div>
              <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
                <Select
                  value={statusFilter}
                  onValueChange={(v) => navigateTo({ flag: v === "all" ? null : v })}
                >
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="ch">CH Student</SelectItem>
                    <SelectItem value="honors">Honors College</SelectItem>
                    <SelectItem value="first_gen">First-Generation</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={standingFilter}
                  onValueChange={(v) => navigateTo({ standing: v === "all" ? null : v })}
                >
                  <SelectTrigger className="w-full sm:w-44">
                    <SelectValue placeholder="All standings" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All standings</SelectItem>
                    {CLASS_STANDINGS.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          }
          trailing={
            <>
              <Button
                size="sm"
                onClick={() => setAddStudentOpen(true)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Add Student
              </Button>
            </>
          }
        />

        {/* Students Table */}
        <AppCard>
          <AppCardContent className="p-0">
            {students.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No students found"
                description={
                  hasActiveCriteria
                    ? "Try adjusting your filters or search query."
                    : "Get started by adding your first student."
                }
                action={
                  hasActiveCriteria ? (
                    <Button variant="outline" onClick={handleClearFilters}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button onClick={() => setAddStudentOpen(true)}>
                      <UserPlus className="mr-2 h-4 w-4" />
                      Add Student
                    </Button>
                  )
                }
              />
            ) : (
              <>
                {/* ── Mobile card list (below md) ───────────────── */}
                <div className="md:hidden divide-y divide-gray-200">
                  {students.map((student) => (
                    <div key={student.student_id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/students/${student.student_id}`}
                            prefetch={false}
                            className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                          >
                            {student.full_name}
                          </Link>
                          <p className="mt-0.5 truncate text-sm text-slate-500">{student.email}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                            {student.class_standing && (
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs">
                                {student.class_standing}
                              </span>
                            )}
                            {student.gpa != null && (
                              <span>GPA {student.gpa.toFixed(2)}</span>
                            )}
                          </div>
                          {(student.is_ch_student || student.first_gen || student.honors_college) && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {student.is_ch_student && <MetricBadge tone="green">CH</MetricBadge>}
                              {student.first_gen && <MetricBadge tone="blue">First Gen</MetricBadge>}
                              {student.honors_college && <MetricBadge tone="amber">Honors</MetricBadge>}
                            </div>
                          )}
                        </div>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-slate-500">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleRowClick(student.student_id)}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openEdit(student)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <LifecycleAction
                          entity="student"
                          entityId={student.student_id}
                          entityLabel={student.full_name}
                          action={archiveView ? "restore" : "archive"}
                          variant="ghost"
                          iconOnly
                          className="h-9 w-9 shrink-0 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* ── Desktop table (md+) ───────────────────────── */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr className="border-b border-gray-200">
                        <th
                          onClick={() => handleSort("full_name")}
                          className="cursor-pointer px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900 sm:px-6 sm:py-3"
                        >
                          <div className="flex items-center">
                            Name
                            <SortIcon field="full_name" />
                          </div>
                        </th>
                        <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 sm:px-6 sm:py-3 md:table-cell">
                          Email
                        </th>
                        <th
                          onClick={() => handleSort("major")}
                          className="hidden cursor-pointer px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900 sm:px-6 sm:py-3 lg:table-cell"
                        >
                          <div className="flex items-center">
                            Major
                            <SortIcon field="major" />
                          </div>
                        </th>
                        <th
                          onClick={() => handleSort("gpa")}
                          className="hidden cursor-pointer px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900 sm:px-6 sm:py-3 sm:table-cell"
                        >
                          <div className="flex items-center">
                            GPA
                            <SortIcon field="gpa" />
                          </div>
                        </th>
                        <th
                          onClick={() => handleSort("class_standing")}
                          className="cursor-pointer px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 hover:text-gray-900 sm:px-6 sm:py-3"
                        >
                          <div className="flex items-center">
                            Class Standing
                            <SortIcon field="class_standing" />
                          </div>
                        </th>
                        <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-600 sm:px-6 sm:py-3 xl:table-cell">
                          Tags
                        </th>
                        <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-600 sm:px-6 sm:py-3">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {students.map((student) => (
                        <tr
                          key={student.student_id}
                          onClick={() => handleRowClick(student.student_id)}
                          className="cursor-pointer motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50"
                        >
                          <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                            <Link
                              href={`/students/${student.student_id}`}
                              prefetch={false}
                              className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {student.full_name}
                            </Link>
                          </td>
                          <td className="hidden px-3 py-3 sm:px-6 sm:py-4 md:table-cell">
                            <div className="max-w-xs truncate text-sm text-slate-600">
                              {student.email}
                            </div>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 lg:table-cell">
                            <div className="text-sm text-slate-600">
                              {student.major || "—"}
                            </div>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 sm:table-cell">
                            <div className="text-sm text-slate-600">
                              {student.gpa != null ? student.gpa.toFixed(2) : "—"}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                            <div className="text-sm text-slate-600">
                              {student.class_standing || "—"}
                            </div>
                          </td>
                          <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 xl:table-cell">
                            <div className="flex flex-wrap gap-1">
                              {student.is_ch_student && <MetricBadge tone="green">CH</MetricBadge>}
                              {student.first_gen && <MetricBadge tone="blue">First Gen</MetricBadge>}
                              {student.honors_college && <MetricBadge tone="amber">Honors</MetricBadge>}
                              {!student.is_ch_student && !student.first_gen && !student.honors_college && (
                                <span className="text-sm text-slate-400">—</span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
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
                                      openEdit(student);
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
                                  <LifecycleAction
                                    entity="student"
                                    entityId={student.student_id}
                                    entityLabel={student.full_name}
                                    action={archiveView ? "restore" : "archive"}
                                    variant="ghost"
                                    iconOnly
                                    className="h-8 w-8 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                  />
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    {archiveView
                                      ? "Restore student"
                                      : "Archive student"}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>{/* end hidden md:block */}
              </>
            )}
          </AppCardContent>
        </AppCard>

        {/* Shared pagination: URL-driven Previous/Next, summary, and
            25/50/100 selector. The server loads the page it points to. */}
        <Pagination
          page={page}
          pageSize={pageSize}
          totalCount={totalCount}
          totalPages={totalPages}
          getPageHref={(p) => {
            const next = updateListSearchParams(searchParams.toString(), { page: p });
            return `/students?${next.toString()}`;
          }}
          getPageSizeHref={(s) => {
            const next = updateListSearchParams(searchParams.toString(), { pageSize: s });
            return `/students?${next.toString()}`;
          }}
          className="mt-4"
        />
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
          <div className="max-h-[70vh] overflow-y-auto px-1">
          <div className="space-y-4 py-4">
            {/* Basic Info */}
            <div className="grid gap-4 sm:grid-cols-2">
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
            </div>

            {/* Academic */}
            <div className="grid gap-4 sm:grid-cols-2">
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

              <div className="space-y-2">
                <Label htmlFor="minor">Minor</Label>
                <Input
                  id="minor"
                  value={newStudent.minor}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, minor: e.target.value })
                  }
                  placeholder="Mathematics"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
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
                    <SelectItem value="Doctoral">Doctoral</SelectItem>
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

            {/* Personal */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="age">Age</Label>
                <Input
                  id="age"
                  type="number"
                  min="1"
                  max="120"
                  value={newStudent.age}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, age: e.target.value })
                  }
                  placeholder="21"
                />
                {formErrors.age && (
                  <p className="text-sm text-red-600">{formErrors.age}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="gender">Gender</Label>
                <Select
                  value={newStudent.gender || "none"}
                  onValueChange={(v) =>
                    setNewStudent({ ...newStudent, gender: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger id="gender">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {GENDER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pronouns">Pronouns</Label>
                <Input
                  id="pronouns"
                  value={newStudent.pronouns}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, pronouns: e.target.value })
                  }
                  placeholder="e.g. he/him, she/her"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="race_ethnicity">Race / Ethnicity</Label>
                <Input
                  id="race_ethnicity"
                  value={newStudent.race_ethnicity}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, race_ethnicity: e.target.value })
                  }
                  placeholder="e.g. Hispanic or Latino"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="languages">Languages</Label>
              <Input
                id="languages"
                value={newStudent.languages}
                onChange={(e) =>
                  setNewStudent({ ...newStudent, languages: e.target.value })
                }
                placeholder="e.g. English, Spanish"
              />
            </div>

            {/* Flags */}
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="is_ch_student" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="is_ch_student"
                  checked={newStudent.is_ch_student}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, is_ch_student: e.target.checked })
                  }
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">CH Student</span>
              </label>
              <label htmlFor="first_gen" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="first_gen"
                  checked={newStudent.first_gen}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, first_gen: e.target.checked })
                  }
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">First Generation</span>
              </label>
              <label htmlFor="honors_college" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="honors_college"
                  checked={newStudent.honors_college}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, honors_college: e.target.checked })
                  }
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">Honors College</span>
              </label>
              <label htmlFor="us_citizen" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="us_citizen"
                  checked={newStudent.us_citizen}
                  onChange={(e) =>
                    setNewStudent({ ...newStudent, us_citizen: e.target.checked })
                  }
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">US Citizen</span>
              </label>
            </div>
          </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddStudentOpen(false);
                setNewStudent(EMPTY_STUDENT_FORM);
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

      {/* Edit Student Dialog */}
      <Dialog open={editStudentOpen} onOpenChange={setEditStudentOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Student</DialogTitle>
            <DialogDescription>
              Update the student information below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit_full_name">
                Full Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit_full_name"
                value={editForm.full_name}
                onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                placeholder="John Doe"
              />
              {editFormErrors.full_name && (
                <p className="text-sm text-red-600">{editFormErrors.full_name}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit_email">
                Email <span className="text-red-500">*</span>
              </Label>
              <Input
                id="edit_email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                placeholder="john.doe@fgcu.edu"
              />
              {editFormErrors.email && (
                <p className="text-sm text-red-600">{editFormErrors.email}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit_student_id">Student ID</Label>
              <Input
                id="edit_student_id"
                value={editingStudent?.student_id ?? ""}
                disabled
                className="bg-gray-50"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit_major">Major</Label>
              <Input
                id="edit_major"
                value={editForm.major}
                onChange={(e) => setEditForm({ ...editForm, major: e.target.value })}
                placeholder="Computer Science"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit_class_standing">Class Standing</Label>
                <Select
                  value={editForm.class_standing}
                  onValueChange={(v) => setEditForm({ ...editForm, class_standing: v })}
                >
                  <SelectTrigger id="edit_class_standing">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Freshman">Freshman</SelectItem>
                    <SelectItem value="Sophomore">Sophomore</SelectItem>
                    <SelectItem value="Junior">Junior</SelectItem>
                    <SelectItem value="Senior">Senior</SelectItem>
                    <SelectItem value="Graduate">Graduate</SelectItem>
                    <SelectItem value="Doctoral">Doctoral</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit_gpa">GPA</Label>
                <Input
                  id="edit_gpa"
                  type="number"
                  step="0.01"
                  min="0"
                  max="4.0"
                  value={editForm.gpa}
                  onChange={(e) => setEditForm({ ...editForm, gpa: e.target.value })}
                  placeholder="3.75"
                />
                {editFormErrors.gpa && (
                  <p className="text-sm text-red-600">{editFormErrors.gpa}</p>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="edit_is_ch_student" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="edit_is_ch_student"
                  checked={editForm.is_ch_student}
                  onChange={(e) => setEditForm({ ...editForm, is_ch_student: e.target.checked })}
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">CH Student</span>
              </label>
              <label htmlFor="edit_first_gen" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="edit_first_gen"
                  checked={editForm.first_gen}
                  onChange={(e) => setEditForm({ ...editForm, first_gen: e.target.checked })}
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">First Generation</span>
              </label>
              <label htmlFor="edit_honors_college" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="edit_honors_college"
                  checked={editForm.honors_college}
                  onChange={(e) => setEditForm({ ...editForm, honors_college: e.target.checked })}
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">Honors College</span>
              </label>
              <label htmlFor="edit_us_citizen" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 hover:bg-gray-50">
                <input
                  type="checkbox"
                  id="edit_us_citizen"
                  checked={editForm.us_citizen}
                  onChange={(e) => setEditForm({ ...editForm, us_citizen: e.target.checked })}
                  className="h-5 w-5 rounded border-gray-300 text-[#006747] focus:ring-[#006747]"
                />
                <span className="text-sm font-medium text-slate-700">US Citizen</span>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditStudentOpen(false);
                setEditingStudent(null);
                setEditForm(EMPTY_STUDENT_FORM);
                setEditFormErrors({});
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEditSubmit}
              disabled={isLoading}
              className="bg-[#006747] hover:bg-[#00563b]"
            >
              {isLoading ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* No destructive delete dialog: lifecycle is handled by LifecycleAction
          (Archive / Restore) which renders its own confirmation dialog. The
          historical destructive delete control has been removed; archived
          students remain reachable in the explicit archive filter context
          (`?view=archived`) and can be restored by an administrator. */}
    </TooltipProvider>
  );
}
