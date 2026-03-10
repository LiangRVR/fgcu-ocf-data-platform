"use client";

import { useState, useMemo, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  Search,
  Pencil,
  Trash2,
  FilePlus,
  FileText,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type Application = Database["public"]["Tables"]["application"]["Row"] & {
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

// Valid stages from the schema CHECK constraint
const STAGES = [
  "Started",
  "Submitted",
  "Under Review",
  "Semi-Finalist",
  "Finalist",
  "Awarded",
  "Rejected",
] as const;

type Stage = (typeof STAGES)[number];

// Derive which boolean flags are consistent with a given stage
function deriveFlags(stage: Stage): { is_semi_finalist: boolean; is_finalist: boolean } {
  if (stage === "Finalist" || stage === "Awarded") {
    return { is_semi_finalist: true, is_finalist: true };
  }
  if (stage === "Semi-Finalist") {
    return { is_semi_finalist: true, is_finalist: false };
  }
  return { is_semi_finalist: false, is_finalist: false };
}

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
    default:
      return "border-gray-200 bg-gray-100 text-gray-700";
  }
}

// Validate that stage and boolean flags are internally consistent.
// Returns an error string or null if valid.
function validateConsistency(
  stage: string,
  is_semi_finalist: boolean,
  is_finalist: boolean
): string | null {
  const earlyStages = ["Started", "Submitted", "Under Review", "Rejected"];

  if (is_finalist && !is_semi_finalist) {
    return "A finalist must also be marked as a semi-finalist.";
  }
  if (is_finalist && earlyStages.includes(stage)) {
    return `Stage "${stage}" conflicts with Finalist status. A finalist must have a stage of Finalist or Awarded.`;
  }
  if (is_semi_finalist && earlyStages.includes(stage)) {
    return `Stage "${stage}" conflicts with Semi-Finalist status. A semi-finalist must have a stage of Semi-Finalist, Finalist, or Awarded.`;
  }
  if (stage === "Finalist" && !is_finalist) {
    return 'Stage is "Finalist" but the Finalist flag is not checked.';
  }
  if (stage === "Semi-Finalist" && !is_semi_finalist) {
    return 'Stage is "Semi-Finalist" but the Semi-Finalist flag is not checked.';
  }
  if (stage === "Awarded" && !is_finalist) {
    return 'Stage is "Awarded" but the Finalist flag is not checked.';
  }
  return null;
}

interface ApplicationsTableProps {
  initialApplications: Application[];
  students: StudentRow[];
  fellowships: FellowshipRow[];
  defaultStudentId?: string;
  defaultFellowshipId?: string;
  autoOpenAdd?: boolean;
  initialStageFilter?: string;
  initialSearchQuery?: string;
}

const EMPTY_FORM = {
  student_id: "",
  fellowship_id: "",
  destination_country: "",
  stage_of_application: "Started" as Stage,
  is_semi_finalist: false,
  is_finalist: false,
};

export function ApplicationsTable({
  initialApplications,
  students,
  fellowships,
  defaultStudentId,
  defaultFellowshipId,
  autoOpenAdd,
  initialStageFilter,
  initialSearchQuery,
}: ApplicationsTableProps) {
  const [applications, setApplications] =
    useState<Application[]>(initialApplications);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearchQuery ?? "");
  const [stageFilter, setStageFilter] = useState<string>(initialStageFilter ?? "all");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editingApp, setEditingApp] = useState<Application | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);

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

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

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

  const filteredApplications = useMemo(() => {
    let list = applications;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (a) =>
          (a.student?.full_name ?? "").toLowerCase().includes(q) ||
          (a.fellowship?.fellowship_name ?? "").toLowerCase().includes(q) ||
          (a.destination_country ?? "").toLowerCase().includes(q) ||
          a.stage_of_application.toLowerCase().includes(q)
      );
    }

    if (stageFilter !== "all") {
      list = list.filter((a) => a.stage_of_application === stageFilter);
    }

    return list;
  }, [applications, debouncedSearch, stageFilter]);

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};

    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.fellowship_id) errors.fellowship_id = "Fellowship is required.";
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
      const { data, error } = await supabaseBrowserClient
        .from("application")
        .insert({
          student_id: Number(form.student_id),
          fellowship_id: Number(form.fellowship_id),
          destination_country: form.destination_country || null,
          stage_of_application: form.stage_of_application,
          is_semi_finalist: form.is_semi_finalist,
          is_finalist: form.is_finalist,
        })
        .select(
          `*, student(full_name), fellowship(fellowship_name)`
        )
        .single();

      if (error) throw error;

      setApplications((prev) => [data as Application, ...prev]);
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
      const { data, error } = await supabaseBrowserClient
        .from("application")
        .update({
          student_id: Number(form.student_id),
          fellowship_id: Number(form.fellowship_id),
          destination_country: form.destination_country || null,
          stage_of_application: form.stage_of_application,
          is_semi_finalist: form.is_semi_finalist,
          is_finalist: form.is_finalist,
        })
        .eq("application_id", editingApp.application_id)
        .select(`*, student(full_name), fellowship(fellowship_name)`)
        .single();

      if (error) throw error;

      setApplications((prev) =>
        prev.map((a) =>
          a.application_id === editingApp.application_id
            ? (data as Application)
            : a
        )
      );
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

  const handleDeleteConfirm = async () => {
    if (!deleteId) return;
    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("application")
        .delete()
        .eq("application_id", deleteId);

      if (error) throw error;

      setApplications((prev) =>
        prev.filter((a) => a.application_id !== deleteId)
      );
      toast.success("Application deleted.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete application.");
    } finally {
      setIsLoading(false);
      setDeleteId(null);
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
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search by student, fellowship, country…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={stageFilter} onValueChange={setStageFilter}>
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
        <Button
          size="sm"
          className="bg-[#006747] hover:bg-[#00563b]"
          onClick={() => setAddOpen(true)}
        >
          <FilePlus className="mr-2 h-4 w-4" />
          New Application
        </Button>
      </div>

      {/* Applications Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {filteredApplications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <FileText className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">
                No applications found
              </h3>
              <p className="mb-4 text-sm text-slate-500">
                {debouncedSearch || stageFilter !== "all"
                  ? "Try adjusting your search or stage filter."
                  : "Get started by creating your first application."}
              </p>
              {!debouncedSearch && stageFilter === "all" && (
                <Button
                  className="bg-[#006747] hover:bg-[#00563b]"
                  onClick={() => setAddOpen(true)}
                >
                  <FilePlus className="mr-2 h-4 w-4" />
                  New Application
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Student
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Fellowship
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Destination
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Stage
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
                      Semi-Fin.
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500">
                      Finalist
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredApplications.map((app) => (
                    <tr
                      key={app.application_id}
                      className="transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <Link
                          href={`/students/${app.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {app.student?.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <Link
                          href={`/fellowships/${app.fellowship_id}`}
                          className="text-sm text-slate-600 hover:text-[#006747] hover:underline"
                        >
                          {app.fellowship?.fellowship_name ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="text-sm text-slate-600">
                          {app.destination_country ?? "—"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <Badge
                          variant="secondary"
                          className={`rounded-full border px-2 py-0.5 text-xs ${stageBadgeClass(app.stage_of_application)}`}
                        >
                          {app.stage_of_application}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {app.is_semi_finalist ? (
                          <Badge
                            variant="default"
                            className="rounded-full border border-purple-200 bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 hover:bg-purple-100"
                          >
                            Yes
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {app.is_finalist ? (
                          <Badge
                            variant="default"
                            className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-100"
                          >
                            Yes
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete application"
                            onClick={() => setDeleteId(app.application_id)}
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

      {/* Pagination summary */}
      {filteredApplications.length > 0 && (
        <div className="mt-4 text-sm text-slate-500">
          Showing <span className="font-medium">{filteredApplications.length}</span>{" "}
          of <span className="font-medium">{applications.length}</span> applications
        </div>
      )}

      {/* ── Add Application Dialog ─────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New Application</DialogTitle>
            <DialogDescription>
              Record a student&apos;s fellowship application.
            </DialogDescription>
          </DialogHeader>

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

      {/* ── Delete Confirmation ────────────────────────────────── */}
      <AlertDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Application</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The application record will be
              permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={handleDeleteConfirm}
              disabled={isLoading}
            >
              {isLoading ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      <div className="grid grid-cols-2 gap-4">
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-50">
          <input
            type="checkbox"
            className="h-4 w-4 rounded accent-[#006747]"
            checked={form.is_semi_finalist}
            onChange={(e) => onFlagChange("is_semi_finalist", e.target.checked)}
          />
          <span className="text-sm font-medium text-slate-700">Semi-Finalist</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-50">
          <input
            type="checkbox"
            className="h-4 w-4 rounded accent-[#006747]"
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
