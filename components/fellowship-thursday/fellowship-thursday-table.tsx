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
import { Search, Pencil, Trash2, UserPlus, CalendarDays } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type FellowshipThursday =
  Database["public"]["Tables"]["fellowship_thursday"]["Row"] & {
    student: { full_name: string } | null;
  };

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

// Controlled source values per schema CHECK constraint (nullable OK)
const SOURCE_OPTIONS = ["OCF", "HC", "MM"] as const;
type SourceInfo = (typeof SOURCE_OPTIONS)[number];

interface FellowshipThursdayTableProps {
  initialRecords: FellowshipThursday[];
  students: StudentRow[];
  defaultStudentId?: string;
  autoOpenAdd?: boolean;
}

const EMPTY_FORM = {
  student_id: "",
  attended: true,
  source_info: "" as SourceInfo | "",
};

export function FellowshipThursdayTable({
  initialRecords,
  students,
  defaultStudentId,
  autoOpenAdd,
}: FellowshipThursdayTableProps) {
  const [records, setRecords] = useState<FellowshipThursday[]>(initialRecords);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [attendedFilter, setAttendedFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editingRecord, setEditingRecord] = useState<FellowshipThursday | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);

  // Pre-fill and auto-open add dialog when arriving from a contextual link
  useEffect(() => {
    if (autoOpenAdd) {
      setForm((prev) => ({
        ...prev,
        ...(defaultStudentId ? { student_id: defaultStudentId } : {}),
      }));
      setAddOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const filteredRecords = useMemo(() => {
    let list = records;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter((r) =>
        (r.student?.full_name ?? "").toLowerCase().includes(q)
      );
    }

    if (attendedFilter === "yes") {
      list = list.filter((r) => r.attended);
    } else if (attendedFilter === "no") {
      list = list.filter((r) => !r.attended);
    }

    if (sourceFilter !== "all") {
      list = list.filter((r) => r.source_info === sourceFilter);
    }

    return list;
  }, [records, debouncedSearch, attendedFilter, sourceFilter]);

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!f.student_id) errors.student_id = "Student is required.";
    return errors;
  };

  const handleAddSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("fellowship_thursday")
        .insert({
          student_id: Number(form.student_id),
          attended: form.attended,
          source_info: form.source_info || null,
        })
        .select(`*, student(full_name)`)
        .single();

      if (error) throw error;

      setRecords((prev) => [data as FellowshipThursday, ...prev]);
      toast.success("Attendance record created.");
      setAddOpen(false);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to create attendance record.");
    } finally {
      setIsLoading(false);
    }
  };

  const openEdit = (record: FellowshipThursday) => {
    setEditingRecord(record);
    setForm({
      student_id: String(record.student_id),
      attended: record.attended,
      source_info: (record.source_info as SourceInfo) ?? "",
    });
    setFormErrors({});
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingRecord) return;
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("fellowship_thursday")
        .update({
          student_id: Number(form.student_id),
          attended: form.attended,
          source_info: form.source_info || null,
        })
        .eq("attendance_id", editingRecord.attendance_id)
        .select(`*, student(full_name)`)
        .single();

      if (error) throw error;

      setRecords((prev) =>
        prev.map((r) =>
          r.attendance_id === editingRecord.attendance_id
            ? (data as FellowshipThursday)
            : r
        )
      );
      toast.success("Attendance record updated.");
      setEditOpen(false);
      setEditingRecord(null);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to update attendance record.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteId) return;
    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("fellowship_thursday")
        .delete()
        .eq("attendance_id", deleteId);

      if (error) throw error;

      setRecords((prev) => prev.filter((r) => r.attendance_id !== deleteId));
      toast.success("Attendance record deleted.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete attendance record.");
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
    setEditingRecord(null);
    setEditOpen(false);
  };

  const sourceLabel: Record<string, string> = { OCF: "OCF", HC: "Honors College", MM: "Mass Media" };

  return (
    <>
      {/* Control Bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search by student name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={attendedFilter} onValueChange={setAttendedFilter}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="All attendance" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All attendance</SelectItem>
              <SelectItem value="yes">Attended</SelectItem>
              <SelectItem value="no">Not attended</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {SOURCE_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {sourceLabel[s]}
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
          <UserPlus className="mr-2 h-4 w-4" />
          Add Record
        </Button>
      </div>

      {/* Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <CalendarDays className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">
                No attendance records found
              </h3>
              <p className="mb-4 text-sm text-slate-500">
                {debouncedSearch || attendedFilter !== "all" || sourceFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Start tracking Thursday meeting attendance."}
              </p>
              {!debouncedSearch && attendedFilter === "all" && sourceFilter === "all" && (
                <Button
                  className="bg-[#006747] hover:bg-[#00563b]"
                  onClick={() => setAddOpen(true)}
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Record
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
                      Attended
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      Source
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredRecords.map((record) => (
                    <tr
                      key={record.attendance_id}
                      className="transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="font-medium text-slate-900">
                          {record.student?.full_name ? (
                            <Link
                              href={`/students/${record.student_id}`}
                              className="hover:text-[#006747] hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {record.student.full_name}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {record.attended ? (
                          <Badge
                            variant="secondary"
                            className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
                          >
                            Yes
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                          >
                            No
                          </Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {record.source_info ? (
                          <Badge
                            variant="secondary"
                            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                              record.source_info === "OCF"
                                ? "border-[#006747]/30 bg-[#006747]/10 text-[#006747]"
                                : record.source_info === "HC"
                                ? "border-purple-200 bg-purple-100 text-purple-800"
                                : "border-amber-200 bg-amber-100 text-amber-800"
                            }`}
                          >
                            {sourceLabel[record.source_info] ?? record.source_info}
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit record"
                            onClick={() => openEdit(record)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete record"
                            onClick={() => setDeleteId(record.attendance_id)}
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

      {/* Record count */}
      {filteredRecords.length > 0 && (
        <div className="mt-4 text-sm text-slate-500">
          Showing <span className="font-medium">{filteredRecords.length}</span>{" "}
          of <span className="font-medium">{records.length}</span> records
        </div>
      )}

      {/* ── Add Dialog ────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Attendance Record</DialogTitle>
            <DialogDescription>
              Log a student&apos;s Fellowship Thursday attendance.
            </DialogDescription>
          </DialogHeader>

          <ThursdayForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
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
              {isLoading ? "Saving…" : "Add Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && resetAndCloseEdit()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Attendance Record</DialogTitle>
            <DialogDescription>
              Update this Fellowship Thursday attendance record.
            </DialogDescription>
          </DialogHeader>

          <ThursdayForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
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

      {/* ── Delete Confirmation ────────────────── */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The attendance record will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isLoading}
              className="bg-red-600 hover:bg-red-700"
            >
              {isLoading ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Shared Form Component ──────────────────────────────────────────────────

interface ThursdayFormProps {
  form: typeof EMPTY_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  formErrors: Record<string, string>;
  students: StudentRow[];
}

function ThursdayForm({ form, setForm, formErrors, students }: ThursdayFormProps) {
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="ft_student_id">
          Student <span className="text-red-500">*</span>
        </Label>
        <Select
          value={form.student_id}
          onValueChange={(v) => setForm((prev) => ({ ...prev, student_id: v }))}
        >
          <SelectTrigger
            id="ft_student_id"
            className={formErrors.student_id ? "border-red-500" : ""}
          >
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
          <p className="text-xs text-red-500">{formErrors.student_id}</p>
        )}
      </div>

      {/* Attended */}
      <div className="flex items-center gap-3">
        <input
          id="ft_attended"
          type="checkbox"
          checked={form.attended}
          onChange={(e) => setForm((prev) => ({ ...prev, attended: e.target.checked }))}
          className="h-4 w-4 rounded border-gray-300 accent-[#006747]"
        />
        <Label htmlFor="ft_attended" className="cursor-pointer font-normal">
          Student attended
        </Label>
      </div>

      {/* Source Info */}
      <div className="grid gap-1.5">
        <Label htmlFor="ft_source_info">Source</Label>
        <Select
          value={form.source_info}
          onValueChange={(v) =>
            setForm((prev) => ({ ...prev, source_info: v as SourceInfo | "" }))
          }
        >
          <SelectTrigger id="ft_source_info">
            <SelectValue placeholder="Select source (optional)…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">— None —</SelectItem>
            <SelectItem value="OCF">OCF</SelectItem>
            <SelectItem value="HC">Honors College</SelectItem>
            <SelectItem value="MM">Mass Media</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-slate-400">
          Indicates which office originated the student&apos;s involvement.
        </p>
      </div>
    </div>
  );
}
