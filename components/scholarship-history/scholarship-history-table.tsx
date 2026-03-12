"use client";

import { useState, useMemo, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, Trash2, Plus, BookOpen, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type ScholarshipHistory =
  Database["public"]["Tables"]["scholarship_history"]["Row"] & {
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

interface ScholarshipHistoryTableProps {
  initialRecords: ScholarshipHistory[];
  students: StudentRow[];
  fellowships: FellowshipRow[];
  defaultStudentId?: string;
  defaultFellowshipId?: string;
  autoOpenAdd?: boolean;
}

const EMPTY_FORM = {
  student_id: "",
  fellowship_id: "",
};

export function ScholarshipHistoryTable({
  initialRecords,
  students,
  fellowships,
  defaultStudentId,
  defaultFellowshipId,
  autoOpenAdd,
}: ScholarshipHistoryTableProps) {
  const [records, setRecords] = useState<ScholarshipHistory[]>(initialRecords);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [fellowshipFilter, setFellowshipFilter] = useState<string>("all");

  const [addOpen, setAddOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  const filteredRecords = useMemo(() => {
    let list = records;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (r) =>
          (r.student?.full_name ?? "").toLowerCase().includes(q) ||
          (r.fellowship?.fellowship_name ?? "").toLowerCase().includes(q)
      );
    }

    if (fellowshipFilter !== "all") {
      list = list.filter((r) => String(r.fellowship_id) === fellowshipFilter);
    }

    return list;
  }, [records, debouncedSearch, fellowshipFilter]);

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.fellowship_id) errors.fellowship_id = "Fellowship is required.";
    return errors;
  };

  const handleAddSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("scholarship_history")
        .insert({
          student_id: Number(form.student_id),
          fellowship_id: Number(form.fellowship_id),
        })
        .select(`*, student(full_name), fellowship(fellowship_name)`)
        .single();

      if (error) throw error;

      setRecords((prev) => [data as ScholarshipHistory, ...prev]);
      toast.success("Scholarship history record added.");
      setAddOpen(false);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to add scholarship history record.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteId) return;
    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("scholarship_history")
        .delete()
        .eq("history_id", deleteId);

      if (error) throw error;

      setRecords((prev) => prev.filter((r) => r.history_id !== deleteId));
      toast.success("Record deleted.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete record.");
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

  return (
    <>
      {/* Control Bar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search by student or fellowship…"
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
              {fellowshipFilter !== "all" && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#006747] text-[10px] font-bold text-white">
                  •
                </span>
              )}
            </Button>
          </div>
          <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
            <Select value={fellowshipFilter} onValueChange={setFellowshipFilter}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="All fellowships" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All fellowships</SelectItem>
                {fellowships.map((f) => (
                  <SelectItem key={f.fellowship_id} value={String(f.fellowship_id)}>
                    {f.fellowship_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          size="sm"
          className="bg-[#006747] hover:bg-[#00563b]"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Record
        </Button>
      </div>

      {/* Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {filteredRecords.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <BookOpen className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">
                No scholarship history found
              </h3>
              <p className="mb-4 text-sm text-slate-500">
                {debouncedSearch || fellowshipFilter !== "all"
                  ? "Try adjusting your search or filter."
                  : "Start recording prior scholarship and fellowship awards."}
              </p>
              {!debouncedSearch && fellowshipFilter === "all" && (
                <Button
                  className="bg-[#006747] hover:bg-[#00563b]"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Record
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {filteredRecords.map((record) => (
                  <div key={record.history_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/students/${record.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {record.student?.full_name ?? "—"}
                        </Link>
                        <div className="mt-0.5 text-sm text-slate-500">
                          <Link
                            href={`/fellowships/${record.fellowship_id}`}
                            className="hover:text-[#006747] hover:underline"
                          >
                            {record.fellowship?.fellowship_name ?? "—"}
                          </Link>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-slate-500 hover:text-red-600"
                        title="Delete record"
                        onClick={() => setDeleteId(record.history_id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Student
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Fellowship / Scholarship
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredRecords.map((record) => (
                    <tr
                      key={record.history_id}
                      className="transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/students/${record.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {record.student?.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/fellowships/${record.fellowship_id}`}
                          className="text-sm text-slate-600 hover:text-[#006747] hover:underline"
                        >
                          {record.fellowship?.fellowship_name ?? "—"}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="flex items-center justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete record"
                            onClick={() => setDeleteId(record.history_id)}
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
            </>
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

      {/* ── Add Dialog ──────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Scholarship History</DialogTitle>
            <DialogDescription>
              Record a prior scholarship or fellowship award for a student.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {/* Student */}
            <div className="grid gap-1.5">
              <Label htmlFor="sh_student_id">
                Student <span className="text-red-500">*</span>
              </Label>
              <Select
                value={form.student_id}
                onValueChange={(v) => setForm((prev) => ({ ...prev, student_id: v }))}
              >
                <SelectTrigger
                  id="sh_student_id"
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

            {/* Fellowship */}
            <div className="grid gap-1.5">
              <Label htmlFor="sh_fellowship_id">
                Fellowship / Scholarship <span className="text-red-500">*</span>
              </Label>
              <Select
                value={form.fellowship_id}
                onValueChange={(v) => setForm((prev) => ({ ...prev, fellowship_id: v }))}
              >
                <SelectTrigger
                  id="sh_fellowship_id"
                  className={formErrors.fellowship_id ? "border-red-500" : ""}
                >
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
                <p className="text-xs text-red-500">{formErrors.fellowship_id}</p>
              )}
            </div>
          </div>

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

      {/* ── Delete Confirmation ──────────────────── */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The scholarship history entry will be permanently removed.
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
