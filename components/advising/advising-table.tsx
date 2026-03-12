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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Search, Pencil, Trash2, CalendarPlus, Calendar, MoreHorizontal, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type AdvisingMeeting = Database["public"]["Tables"]["advising_meeting"]["Row"] & {
  student: { full_name: string } | null;
  advisor: { advisor_name: string } | null;
};

type StudentRow = Pick<
  Database["public"]["Tables"]["student"]["Row"],
  "student_id" | "full_name"
>;

type AdvisorRow = Pick<
  Database["public"]["Tables"]["advisor"]["Row"],
  "advisor_id" | "advisor_name"
>;

const MEETING_MODES = ["In-Person", "Virtual"] as const;
type MeetingMode = (typeof MEETING_MODES)[number];

interface AdvisingTableProps {
  initialMeetings: AdvisingMeeting[];
  students: StudentRow[];
  advisors: AdvisorRow[];
  defaultStudentId?: string;
  defaultAdvisorId?: string;
  autoOpenAdd?: boolean;
  initialNoShowFilter?: string;
}

const EMPTY_FORM = {
  student_id: "",
  advisor_id: "",
  meeting_date: "",
  meeting_mode: "In-Person" as MeetingMode,
  no_show: false,
  notes: "",
};

export function AdvisingTable({
  initialMeetings,
  students,
  advisors,
  defaultStudentId,
  defaultAdvisorId,
  autoOpenAdd,
  initialNoShowFilter,
}: AdvisingTableProps) {
  const [meetings, setMeetings] = useState<AdvisingMeeting[]>(initialMeetings);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [modeFilter, setModeFilter] = useState<string>("all");
  const [noShowFilter, setNoShowFilter] = useState<string>(initialNoShowFilter ?? "all");

  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [editingMeeting, setEditingMeeting] = useState<AdvisingMeeting | null>(null);

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
        ...(defaultAdvisorId ? { advisor_id: defaultAdvisorId } : {}),
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

  const filteredMeetings = useMemo(() => {
    let list = meetings;

    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      list = list.filter(
        (m) =>
          (m.student?.full_name ?? "").toLowerCase().includes(q) ||
          (m.advisor?.advisor_name ?? "").toLowerCase().includes(q) ||
          (m.notes ?? "").toLowerCase().includes(q) ||
          m.meeting_mode.toLowerCase().includes(q)
      );
    }

    if (modeFilter !== "all") {
      list = list.filter((m) => m.meeting_mode === modeFilter);
    }

    if (noShowFilter === "yes") {
      list = list.filter((m) => m.no_show);
    } else if (noShowFilter === "no") {
      list = list.filter((m) => !m.no_show);
    }

    return list;
  }, [meetings, debouncedSearch, modeFilter, noShowFilter]);

  const validateForm = (f: typeof form): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!f.student_id) errors.student_id = "Student is required.";
    if (!f.meeting_date) errors.meeting_date = "Meeting date is required.";
    if (!f.meeting_mode) errors.meeting_mode = "Meeting mode is required.";
    return errors;
  };

  const handleAddSubmit = async () => {
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("advising_meeting")
        .insert({
          student_id: Number(form.student_id),
          advisor_id: form.advisor_id ? Number(form.advisor_id) : null,
          meeting_date: form.meeting_date,
          meeting_mode: form.meeting_mode,
          no_show: form.no_show,
          notes: form.notes || null,
        })
        .select(`*, student(full_name), advisor(advisor_name)`)
        .single();

      if (error) throw error;

      setMeetings((prev) => [data as AdvisingMeeting, ...prev]);
      toast.success("Meeting recorded successfully.");
      setAddOpen(false);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to create meeting.");
    } finally {
      setIsLoading(false);
    }
  };

  const openEdit = (meeting: AdvisingMeeting) => {
    setEditingMeeting(meeting);
    setForm({
      student_id: String(meeting.student_id),
      advisor_id: meeting.advisor_id ? String(meeting.advisor_id) : "",
      meeting_date: meeting.meeting_date,
      meeting_mode: meeting.meeting_mode as MeetingMode,
      no_show: meeting.no_show,
      notes: meeting.notes ?? "",
    });
    setFormErrors({});
    setEditOpen(true);
  };

  const handleEditSubmit = async () => {
    if (!editingMeeting) return;
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient
        .from("advising_meeting")
        .update({
          student_id: Number(form.student_id),
          advisor_id: form.advisor_id ? Number(form.advisor_id) : null,
          meeting_date: form.meeting_date,
          meeting_mode: form.meeting_mode,
          no_show: form.no_show,
          notes: form.notes || null,
        })
        .eq("meeting_id", editingMeeting.meeting_id)
        .select(`*, student(full_name), advisor(advisor_name)`)
        .single();

      if (error) throw error;

      setMeetings((prev) =>
        prev.map((m) =>
          m.meeting_id === editingMeeting.meeting_id ? (data as AdvisingMeeting) : m
        )
      );
      toast.success("Meeting updated successfully.");
      setEditOpen(false);
      setEditingMeeting(null);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (err) {
      console.error(err);
      toast.error("Failed to update meeting.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteId) return;
    setIsLoading(true);
    try {
      const { error } = await supabaseBrowserClient
        .from("advising_meeting")
        .delete()
        .eq("meeting_id", deleteId);

      if (error) throw error;

      setMeetings((prev) => prev.filter((m) => m.meeting_id !== deleteId));
      toast.success("Meeting deleted.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete meeting.");
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
    setEditingMeeting(null);
    setEditOpen(false);
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
                placeholder="Search by student, advisor, notes…"
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
              {(modeFilter !== "all" || noShowFilter !== "all") && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#006747] text-[10px] font-bold text-white">
                  •
                </span>
              )}
            </Button>
          </div>
          <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
            <Select value={modeFilter} onValueChange={setModeFilter}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="All modes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modes</SelectItem>
                {MEETING_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={noShowFilter} onValueChange={setNoShowFilter}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="All attendance" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All attendance</SelectItem>
                <SelectItem value="no">Attended</SelectItem>
                <SelectItem value="yes">No-show</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          size="sm"
          className="bg-[#006747] hover:bg-[#00563b]"
          onClick={() => setAddOpen(true)}
        >
          <CalendarPlus className="mr-2 h-4 w-4" />
          Log Meeting
        </Button>
      </div>

      {/* Table */}
      <Card className="border-gray-200 shadow-sm">
        <CardContent className="p-0">
          {filteredMeetings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gray-100">
                <Calendar className="h-10 w-10 text-gray-400" />
              </div>
              <h3 className="mb-2 text-lg font-semibold text-slate-900">
                No meetings found
              </h3>
              <p className="mb-4 text-sm text-slate-500">
                {debouncedSearch || modeFilter !== "all" || noShowFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Get started by logging your first advising meeting."}
              </p>
              {!debouncedSearch && modeFilter === "all" && noShowFilter === "all" && (
                <Button
                  className="bg-[#006747] hover:bg-[#00563b]"
                  onClick={() => setAddOpen(true)}
                >
                  <CalendarPlus className="mr-2 h-4 w-4" />
                  Log Meeting
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {filteredMeetings.map((meeting) => (
                  <div key={meeting.meeting_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/students/${meeting.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {meeting.student?.full_name ?? "—"}
                        </Link>
                        <div className="mt-0.5 text-sm text-slate-500">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                            "en-US",
                            { year: "numeric", month: "short", day: "numeric" }
                          )}
                          {meeting.advisor_id && (
                            <span className="ml-1.5 text-slate-400">
                              &middot;{" "}
                              <Link
                                href={`/advisors/${meeting.advisor_id}`}
                                className="hover:text-[#006747] hover:underline"
                              >
                                {meeting.advisor?.advisor_name ?? "—"}
                              </Link>
                            </span>
                          )}
                        </div>
                        {meeting.notes && (
                          <div className="mt-0.5 truncate text-xs text-slate-400 max-w-xs">
                            {meeting.notes}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="secondary"
                            className={`rounded-full border px-2 py-0.5 text-xs ${
                              meeting.meeting_mode === "Virtual"
                                ? "border-blue-200 bg-blue-100 text-blue-800"
                                : "border-slate-200 bg-slate-100 text-slate-700"
                            }`}
                          >
                            {meeting.meeting_mode}
                          </Badge>
                          {meeting.no_show ? (
                            <Badge variant="destructive" className="rounded-full px-2 py-0.5 text-xs font-medium">
                              No-show
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                              Attended
                            </Badge>
                          )}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-slate-500">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(meeting)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onClick={() => setDeleteId(meeting.meeting_id)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 md:table-cell">
                      Advisor
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Date
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 sm:table-cell">
                      Mode
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      No-Show
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3 lg:table-cell">
                      Notes
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredMeetings.map((meeting) => (
                    <tr
                      key={meeting.meeting_id}
                      className="transition-colors duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <Link
                          href={`/students/${meeting.student_id}`}
                          className="font-medium text-slate-900 hover:text-[#006747] hover:underline"
                        >
                          {meeting.student?.full_name ?? "—"}
                        </Link>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 md:table-cell">
                        {meeting.advisor_id ? (
                          <Link
                            href={`/advisors/${meeting.advisor_id}`}
                            className="text-sm text-slate-600 hover:text-[#006747] hover:underline"
                          >
                            {meeting.advisor?.advisor_name ?? "—"}
                          </Link>
                        ) : (
                          <span className="text-sm text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="text-sm text-slate-600">
                          {new Date(meeting.meeting_date + "T00:00:00").toLocaleDateString(
                            "en-US",
                            { year: "numeric", month: "short", day: "numeric" }
                          )}
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4 sm:table-cell">
                        <Badge
                          variant="secondary"
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            meeting.meeting_mode === "Virtual"
                              ? "border-blue-200 bg-blue-100 text-blue-800"
                              : "border-slate-200 bg-slate-100 text-slate-700"
                          }`}
                        >
                          {meeting.meeting_mode}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        {meeting.no_show ? (
                          <Badge
                            variant="destructive"
                            className="rounded-full px-2 py-0.5 text-xs font-medium"
                          >
                            Yes
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="rounded-full border border-green-200 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
                          >
                            Attended
                          </Badge>
                        )}
                      </td>
                      <td className="hidden max-w-xs px-3 py-3 sm:px-6 sm:py-4 lg:table-cell">
                        <div className="truncate text-sm text-slate-500">
                          {meeting.notes ? meeting.notes : <span className="text-slate-300">—</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-slate-900"
                            title="Edit meeting"
                            onClick={() => openEdit(meeting)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-slate-600 hover:text-red-600"
                            title="Delete meeting"
                            onClick={() => setDeleteId(meeting.meeting_id)}
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
      {filteredMeetings.length > 0 && (
        <div className="mt-4 text-sm text-slate-500">
          Showing <span className="font-medium">{filteredMeetings.length}</span>{" "}
          of <span className="font-medium">{meetings.length}</span> meetings
        </div>
      )}

      {/* ── Add Meeting Dialog ─────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAndCloseAdd()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Log Advising Meeting</DialogTitle>
            <DialogDescription>
              Record a new advising session between a student and advisor.
            </DialogDescription>
          </DialogHeader>

          <MeetingForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
            advisors={advisors}
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
              {isLoading ? "Saving…" : "Log Meeting"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Meeting Dialog ────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && resetAndCloseEdit()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Meeting</DialogTitle>
            <DialogDescription>
              Update the details for this advising session.
            </DialogDescription>
          </DialogHeader>

          <MeetingForm
            form={form}
            setForm={setForm}
            formErrors={formErrors}
            students={students}
            advisors={advisors}
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

      {/* ── Delete Confirmation ────────────────────────────── */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this meeting?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The advising record will be permanently removed.
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

interface MeetingFormProps {
  form: typeof EMPTY_FORM;
  setForm: React.Dispatch<React.SetStateAction<typeof EMPTY_FORM>>;
  formErrors: Record<string, string>;
  students: StudentRow[];
  advisors: AdvisorRow[];
}

function MeetingForm({ form, setForm, formErrors, students, advisors }: MeetingFormProps) {
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="student_id">
          Student <span className="text-red-500">*</span>
        </Label>
        <Select
          value={form.student_id}
          onValueChange={(v) => setForm((prev) => ({ ...prev, student_id: v }))}
        >
          <SelectTrigger id="student_id" className={formErrors.student_id ? "border-red-500" : ""}>
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

      {/* Advisor */}
      <div className="grid gap-1.5">
        <Label htmlFor="advisor_id">Advisor</Label>
        <Select
          value={form.advisor_id || "none"}
          onValueChange={(v) => setForm((prev) => ({ ...prev, advisor_id: v === "none" ? "" : v }))}
        >
          <SelectTrigger id="advisor_id">
            <SelectValue placeholder="Select an advisor (optional)…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— None —</SelectItem>
            {advisors.map((a) => (
              <SelectItem key={a.advisor_id} value={String(a.advisor_id)}>
                {a.advisor_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Meeting Date */}
      <div className="grid gap-1.5">
        <Label htmlFor="meeting_date">
          Meeting Date <span className="text-red-500">*</span>
        </Label>
        <Input
          id="meeting_date"
          type="date"
          value={form.meeting_date}
          onChange={(e) => setForm((prev) => ({ ...prev, meeting_date: e.target.value }))}
          className={formErrors.meeting_date ? "border-red-500" : ""}
        />
        {formErrors.meeting_date && (
          <p className="text-xs text-red-500">{formErrors.meeting_date}</p>
        )}
      </div>

      {/* Meeting Mode */}
      <div className="grid gap-1.5">
        <Label htmlFor="meeting_mode">
          Mode <span className="text-red-500">*</span>
        </Label>
        <Select
          value={form.meeting_mode}
          onValueChange={(v) =>
            setForm((prev) => ({ ...prev, meeting_mode: v as MeetingMode }))
          }
        >
          <SelectTrigger id="meeting_mode" className={formErrors.meeting_mode ? "border-red-500" : ""}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEETING_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {formErrors.meeting_mode && (
          <p className="text-xs text-red-500">{formErrors.meeting_mode}</p>
        )}
      </div>

      {/* No-Show */}
      <div className="flex items-center gap-3">
        <input
          id="no_show"
          type="checkbox"
          checked={form.no_show}
          onChange={(e) => setForm((prev) => ({ ...prev, no_show: e.target.checked }))}
          className="h-4 w-4 rounded border-gray-300 accent-[#006747]"
        />
        <Label htmlFor="no_show" className="cursor-pointer font-normal">
          Student was a no-show
        </Label>
      </div>

      {/* Notes */}
      <div className="grid gap-1.5">
        <Label htmlFor="notes">Notes</Label>
        <textarea
          id="notes"
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
          placeholder="Optional notes about the meeting…"
          className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </div>
  );
}
