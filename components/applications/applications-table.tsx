"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MetricBadge } from "@/components/ui/metric-badge";
import { Label } from "@/components/ui/label";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Pencil,
  FilePlus,
  FileText,
  MoreHorizontal,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import {
  STAGES,
  type Stage,
  deriveFlags,
  validateConsistency,
  formatApplicationLabel,
} from "@/lib/applications/pipeline";
import type { Database } from "@/types/database";
import { Pagination } from "@/components/pagination/pagination";
import { updateListSearchParams } from "@/lib/utils/pagination";

type Application = Database["public"]["Views"]["application_list"]["Row"] & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
};

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type FellowshipRow = Pick<
  Database["public"]["Tables"]["fellowship"]["Row"],
  "fellowship_id" | "fellowship_name"
>;

// Map stage → badge styling
function stageBadgeClass(stage: string): string {
  switch (stage) {
    case "Started":
      return "border-gray-200 bg-gray-100 text-gray-700";
    case "Submitted":
      return "border-blue-200 bg-blue-100 text-blue-800";
    case "Under Review":
      return "border-amber-200 bg-amber-100 text-amber-800";
    case "Semi-Finalist":
      return "border-purple-200 bg-purple-100 text-purple-800";
    case "Finalist":
      return "border-green-200 bg-green-100 text-green-800";
    case "Awarded":
      return "border-emerald-200 bg-emerald-100 text-emerald-800 font-semibold";
    case "Rejected":
      return "border-red-200 bg-red-100 text-red-700";
    case "Did Not Submit":
      return "border-orange-200 bg-orange-100 text-orange-800";
    case "Withdrawn":
      return "border-slate-300 bg-slate-100 text-slate-700";
    default:
      return "border-gray-200 bg-gray-100 text-gray-700";
  }
}

interface ApplicationsTableProps {
  initialApplications: Application[];
  defaultStudentId?: string;
  defaultFellowshipId?: string;
  autoOpenAdd?: boolean;
  initialStageFilter?: string;
  initialSearchQuery?: string;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const EMPTY_FORM = {
  student_id: "",
  fellowship_id: "",
  application_year: "",
  destination_country: "",
  stage_of_application: "Started" as Stage,
  is_semi_finalist: false,
  is_finalist: false,
};

export function ApplicationsTable({
  initialApplications,
  defaultStudentId,
  defaultFellowshipId,
  autoOpenAdd,
  initialStageFilter,
  initialSearchQuery,
  totalCount, page, pageSize, totalPages,
}: ApplicationsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigate = (patch: Record<string, string | number | null>) => { const next = updateListSearchParams(searchParams.toString(), patch); const query = next.toString(); router.push(query ? `/applications?${query}` : "/applications"); };
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearchQuery ?? "");
  const [stageFilter, setStageFilter] = useState<string>(initialStageFilter ?? "all");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [fellowships, setFellowships] = useState<FellowshipRow[]>([]);
  const [selectorSearch, setSelectorSearch] = useState("");

  useEffect(() => {
    if (!addOpen && !editOpen) return;
    let cancelled = false;
    const load = async () => {
      const term = selectorSearch.trim();
      const studentQuery = supabaseBrowserClient.from("student").select("student_id, full_name").is("archived_at", null).order("full_name").limit(50);
      const fellowshipQuery = supabaseBrowserClient.from("fellowship").select("fellowship_id, fellowship_name").is("archived_at", null).order("fellowship_name").limit(50);
      const [studentResult, fellowshipResult] = await Promise.all([
        term ? studentQuery.ilike("full_name", `%${term.replace(/[\\%_]/g, "\\$&")}%`) : studentQuery,
        term ? fellowshipQuery.ilike("fellowship_name", `%${term.replace(/[\\%_]/g, "\\$&")}%`) : fellowshipQuery,
      ]);
      if (cancelled) return;
      if (!studentResult.error) setStudents(studentResult.data ?? []);
      if (!fellowshipResult.error) setFellowships(fellowshipResult.data ?? []);
    };
    void load();
    return () => { cancelled = true; };
  }, [addOpen, editOpen, selectorSearch]);

  // Pre-fill and auto-open add dialog when arriving from a contextual link
  useEffect(() => {
    if (autoOpenAdd) {
      setForm((prev) => ({
        ...prev,
        ...(defaultStudentId ? { student_id: defaultStudentId } : {}),
        ...(defaultFellowshipId ? { fellowship_id: defaultFellowshipId } : {}),
      }));
      setAddOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search and commit it to canonical URL state.
  // On mount the URL already reflects the server-provided search, so skip the
  // redundant navigation that would otherwise reset the current page. Only
  // navigate once the user's input actually diverges from the URL-backed value.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      const nextSearch = searchQuery || null;
      const urlSearch = searchParams.get("search") || null;
      if (nextSearch === urlSearch) return;
      navigate({ search: nextSearch });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  useEffect(() => { setSearchQuery(initialSearchQuery ?? ""); setStageFilter(initialStageFilter ?? "all"); }, [initialSearchQuery, initialStageFilter]);

  // When stage changes in the form, auto-sync the boolean flags
  const handleStageChange = (stage: Stage) => {
    const flags = deriveFlags(stage);
    setForm((prev) => ({ ...prev, stage_of_application: stage, ...flags }));
    // Clear consistency error when stage changes
    setFormErrors((prev) => {
      const next = { ...prev };
      delete next.consistency;
      return next;
    });
  };

  // When a flag checkbox is toggled, enforce cascade rules immediately:
  //   - Checking "is_finalist" implicitly checks "is_semi_finalist"
  //   - Unchecking "is_semi_finalist" implicitly unchecks "is_finalist"
  const handleFlagChange = (
    field: "is_semi_finalist" | "is_finalist",
    checked: boolean
  ) => {
    setForm((prev) => {
      const next = { ...prev, [field]: checked };
      if (field === "is_finalist" && checked) next.is_semi_finalist = true;
      if (field === "is_semi_finalist" && !checked) next.is_finalist = false;
      return next;
    });
    // Clear any stale consistency error; submit-time validation will re-catch anything remaining
    setFormErrors((prev) => {
      const next = { ...prev };
      delete next.consistency;
      return next;
    });
  };

  const filteredApplications = initialApplications;

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};

    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.fellowship_id) errors.fellowship_id = "Fellowship is required.";
    if (!f.application_year || !/^\d{4}$/.test(f.application_year)) {
      errors.application_year = "Application year is required and must be a 4-digit year.";
    }
    if (!f.stage_of_application)
      errors.stage_of_application = "Stage is required.";

    const consistencyError = validateConsistency(
      f.stage_of_application,
      f.is_semi_finalist,
      f.is_finalist
    );
    if (consistencyError) errors.consistency = consistencyError;

    return errors;
  };

  const handleAddSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("application")
        .insert({
          student_id: Number(form.student_id),
          fellowship_id: Number(form.fellowship_id),
          application_year: Number(form.application_year),
          destination_country: form.destination_country || null,
          stage_of_application: form.stage_of_application,
          is_semi_finalist: form.is_semi_finalist,
          is_finalist: form.is_finalist,
        } as Database["public"]["Tables"]["application"]["Insert"])
        .select(
          `*, student(full_name), fellowship(fellowship_name)`
        )
        .single();

      if (error) throw error;

      router.refresh();
      toast.success("Application created successfully.");
      setAddOpen(false);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to create application.");
    } finally {
      setIsLoading(false);
    }
  };

  const openEdit = (app: Application) => {
    setEditingApp(app);
    setForm({
      student_id: String(app.student_id),
      fellowship_id: String(app.fellowship_id),
      application_year: app.application_year ? String(app.application_year) : "",
      destination_country: app.destination_country ?? "",
      stage_of_application: app.stage_of_application as Stage,
      is_semi_finalist: app.is_semi_finalist,
      is_finalist: app.is_finalist,
    });
    setFormErrors({});
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingApp) return;
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("application")
        .update({
          student_id: Number(form.student_id),
          fellowship_id: Number(form.fellowship_id),
          application_year: Number(form.application_year),
          destination_country: form.destination_country || null,
          stage_of_application: form.stage_of_application,
          is_semi_finalist: form.is_semi_finalist,
          is_finalist: form.is_finalist,
        } as Database["public"]["Tables"]["application"]["Update"])
        .eq("application_id", editingApp.application_id)
        .select(`*, student(full_name), fellowship(fellowship_name)`)
        .single();

      if (error) throw error;

      router.refresh();
      toast.success("Application updated successfully.");
      setEditOpen(false);
      setEditingApp(null);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to update application.");
    } finally {
      setIsLoading(false);
    }
  };

  const resetAndCloseAdd = () => {
    setForm(EMPTY_FORM);
    setFormErrors({});
    setAddOpen(false);
  };

  const resetAndCloseEdit = () => {
    setForm(EMPTY_FORM);
    setFormErrors({});
    setEditingApp(null);
    setEditOpen(false);
  };

  return (
    <>
      {/* Control Bar */}
      <DataToolbar
        className="mb-4"
        leading={
          <>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  placeholder="Search by student, fellowship, country…"
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
                {stageFilter !== "all" && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">
                    •
                  </span>
                )}
              </Button>
            </div>
            <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
              <Select value={stageFilter} onValueChange={(v) => { setStageFilter(v); navigate({ filter: v === "all" ? null : v }); }}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="All stages" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stages</SelectItem>
                  {STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        }
        trailing={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <FilePlus className="mr-2 h-4 w-4" />
            New Application
          </Button>
        }
      />

      {/* Applications Table */}
      <AppCard>
        <AppCardContent className="p-0">
          {filteredApplications.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No applications found"
              description={
                debouncedSearch || stageFilter !== "all"
                  ? "Try adjusting your search or stage filter."
                  : "Get started by creating your first application."
              }
              action={
                !debouncedSearch && stageFilter === "all" ? (
                  <Button onClick={() => setAddOpen(true)}>
                    <FilePlus className="mr-2 h-4 w-4" />
                    New Application
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {filteredApplications.map((app) => (
                  <div key={app.application_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/students/${app.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {app.student?.full_name ?? "—"}
                        </Link>
                        <div className="mt-0.5 text-sm text-slate-500">
                          <Link
                            href={`/fellowships/${app.fellowship_id}`}
                            className="hover:text-[#006747] hover:underline"
                          >
                            {formatApplicationLabel(app.fellowship?.fellowship_name, app.application_year)}
                          </Link>
                        </div>
                        {app.destination_country && (
                          <div className="mt-0.5 text-xs text-slate-400">{app.destination_country}</div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <MetricBadge tone={app.stage_of_application === "Awarded" ? "amber" : app.stage_of_application === "Finalist" ? "green" : app.stage_of_application === "Semi-Finalist" ? "purple" : app.stage_of_application === "Rejected" ? "red" : app.stage_of_application === "Under Review" ? "amber" : app.stage_of_application === "Submitted" ? "blue" : "slate"} className={stageBadgeClass(app.stage_of_application)}>
                            {app.stage_of_application}
                          </MetricBadge>
                          {app.is_semi_finalist && <MetricBadge tone="purple">Semi-Fin.</MetricBadge>}
                          {app.is_finalist && <MetricBadge tone="green">Finalist</MetricBadge>}
                        </div>
                      </div>
<DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-slate-500">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(app)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto md:block">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Student
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Fellowship
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">
                      Destination
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Stage
                    </th>
                    <th className="hidden px-3 py-2 text-center text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 lg:table-cell">
                      Semi-Fin.
                    </th>
                    <th className="hidden px-3 py-2 text-center text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 lg:table-cell">
                      Finalist
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredApplications.map((app) => (
                    <tr
                      key={app.application_id}
                      className="motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/students/${app.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {app.student?.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/fellowships/${app.fellowship_id}`}
                          className="text-sm text-slate-600 hover:text-[#006747] hover:underline"
                        >
                          {formatApplicationLabel(app.fellowship?.fellowship_name, app.application_year)}
                        </Link>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 md:table-cell">
                        <div className="text-sm text-slate-600">
                          {app.destination_country ?? "—"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <MetricBadge tone={app.stage_of_application === "Awarded" ? "amber" : app.stage_of_application === "Finalist" ? "green" : app.stage_of_application === "Semi-Finalist" ? "purple" : app.stage_of_application === "Rejected" ? "red" : app.stage_of_application === "Under Review" ? "amber" : app.stage_of_application === "Submitted" ? "blue" : "slate"} className={stageBadgeClass(app.stage_of_application)}>
                          {app.stage_of_application}
                        </MetricBadge>
                      </td>
                      <td className="hidden px-3 py-3 text-center sm:px-6 sm:py-4 lg:table-cell">
                        {app.is_semi_finalist ? (
                          <MetricBadge tone="purple">Yes</MetricBadge>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-3 text-center sm:px-6 sm:py-4 lg:table-cell">
                        {app.is_finalist ? (
                          <MetricBadge tone="green">Yes</MetricBadge>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit application"
                            onClick={() => openEdit(app)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </AppCardContent>
      </AppCard>

      {/* Pagination summary */}
      <Pagination page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} getPageHref={(p) => { const next = updateListSearchParams(searchParams.toString(), { page: p }); return `/applications?${next.toString()}`; }} getPageSizeHref={(s) => { const next = updateListSearchParams(searchParams.toString(), { pageSize: s }); return `/applications?${next.toString()}`; }} className="mt-4" />

      {/* ── Add Application Dialog ─────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Application</DialogTitle>
            <DialogDescription>
              Record a student&apos;s fellowship application.
            </DialogDescription>
          </DialogHeader>

          <Input aria-label="Search students and fellowships" placeholder="Search students or fellowships…" value={selectorSearch} onChange={(e) => setSelectorSearch(e.target.value)} />
          <ApplicationForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
            fellowships={fellowships}
            onStageChange={handleStageChange}
            onFlagChange={handleFlagChange}
          />

          <DialogFooter>
            <Button variant="outline" onClick={resetAndCloseAdd} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              onClick={handleAddSubmit}
              disabled={isLoading}
              className="bg-[#006747] hover:bg-[#00563b]"
            >
              {isLoading ? "Saving…" : "Create Application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Application Dialog ────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && resetAndCloseEdit()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Application</DialogTitle>
            <DialogDescription>
              Update the details for this application.
            </DialogDescription>
          </DialogHeader>

          <Input aria-label="Search students and fellowships" placeholder="Search students or fellowships…" value={selectorSearch} onChange={(e) => setSelectorSearch(e.target.value)} />
          <ApplicationForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
            fellowships={fellowships}
            onStageChange={handleStageChange}
            onFlagChange={handleFlagChange}
          />

          <DialogFooter>
            <Button variant="outline" onClick={resetAndCloseEdit} disabled={isLoading}>
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

      {/* Terminal outcomes are represented by explicit application stages;
          applications remain available for historical reporting. */}
    </>
  );
}

// ── Shared form fields ──────────────────────────────────────────────────────

interface ApplicationFormProps {
  form: typeof EMPTY_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  formErrors: Record<string, string>;
  students: StudentRow[];
  fellowships: FellowshipRow[];
  onStageChange: (stage: Stage) => void;
  onFlagChange: (field: "is_semi_finalist" | "is_finalist", checked: boolean) => void;
}

function ApplicationForm({
  form,
  setForm,
  formErrors,
  students,
  fellowships,
  onStageChange,
  onFlagChange,
}: ApplicationFormProps) {
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="app-student">Student</Label>
        <Select
          value={form.student_id}
          onValueChange={(v) => setForm((p) => ({ ...p, student_id: v }))}
        >
          <SelectTrigger id="app-student">
            <SelectValue placeholder="Select a student…" />
          </SelectTrigger>
          <SelectContent>
            {students.map((s) => (
              <SelectItem key={s.student_id} value={String(s.student_id)}>
                {s.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {formErrors.student_id && (
          <p className="text-xs text-red-600">{formErrors.student_id}</p>
        )}
      </div>

      {/* Fellowship */}
      <div className="grid gap-1.5">
        <Label htmlFor="app-fellowship">Fellowship</Label>
        <Select
          value={form.fellowship_id}
          onValueChange={(v) => setForm((p) => ({ ...p, fellowship_id: v }))}
        >
          <SelectTrigger id="app-fellowship">
            <SelectValue placeholder="Select a fellowship…" />
          </SelectTrigger>
          <SelectContent>
            {fellowships.map((f) => (
              <SelectItem key={f.fellowship_id} value={String(f.fellowship_id)}>
                {f.fellowship_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {formErrors.fellowship_id && (
          <p className="text-xs text-red-600">{formErrors.fellowship_id}</p>
        )}
      </div>

      {/* Application Year */}
      <div className="grid gap-1.5">
        <Label htmlFor="app-year">Application Year</Label>
        <Input
          id="app-year"
          type="text"
          inputMode="numeric"
          placeholder="e.g. 2026"
          value={form.application_year}
          onChange={(e) =>
            setForm((p) => ({ ...p, application_year: e.target.value }))
          }
          aria-invalid={!!formErrors.application_year}
        />
        {formErrors.application_year && (
          <p className="text-xs text-red-600">{formErrors.application_year}</p>
        )}
      </div>

      {/* Destination Country */}
      <div className="grid gap-1.5">
        <Label htmlFor="app-country">Destination Country</Label>
        <Input
          id="app-country"
          placeholder="e.g. United Kingdom (optional)"
          value={form.destination_country}
          onChange={(e) =>
            setForm((p) => ({ ...p, destination_country: e.target.value }))
          }
        />
      </div>

      {/* Stage */}
      <div className="grid gap-1.5">
        <Label htmlFor="app-stage">Stage of Application</Label>
        <Select
          value={form.stage_of_application}
          onValueChange={(v) => onStageChange(v as Stage)}
        >
          <SelectTrigger id="app-stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {formErrors.stage_of_application && (
          <p className="text-xs text-red-600">
            {formErrors.stage_of_application}
          </p>
        )}
      </div>

      {/* Semi-Finalist / Finalist flags */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-50">
          <input
            type="checkbox"
            className="h-5 w-5 rounded accent-[#006747]"
            checked={form.is_semi_finalist}
            onChange={(e) => onFlagChange("is_semi_finalist", e.target.checked)}
          />
          <span className="text-sm font-medium text-slate-700">Semi-Finalist</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-50">
          <input
            type="checkbox"
            className="h-5 w-5 rounded accent-[#006747]"
            checked={form.is_finalist}
            onChange={(e) => onFlagChange("is_finalist", e.target.checked)}
          />
          <span className="text-sm font-medium text-slate-700">Finalist</span>
        </label>
      </div>

      {/* Consistency error — shown below the flags */}
      {formErrors.consistency && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-xs text-red-700">{formErrors.consistency}</p>
        </div>
      )}

      {/* Helper note */}
      <p className="text-xs text-slate-400">
        Tip: selecting a stage automatically sets the semi-finalist and finalist
        flags to be consistent.
      </p>
    </div>
  );
}
