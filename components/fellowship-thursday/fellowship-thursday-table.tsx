"use client";

import { useState, useMemo, useEffect } from "react";
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
import { Search, UserPlus, CalendarDays, SlidersHorizontal, History } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type FellowshipThursday = Database["public"]["Tables"]["fellowship_thursday"]["Row"] & Partial<Database["public"]["Views"]["effective_fellowship_thursday"]["Row"]> & {
    student: { full_name: string } | null;
  };
type Amendment = Database["public"]["Tables"]["fellowship_thursday_amendment"]["Row"] & { created_by: { advisor_name: string } | null };

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
  const [amendments, setAmendments] = useState<Record<number, Amendment[]>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [attendedFilter, setAttendedFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const [addOpen, setAddOpen] = useState(false);
  const [correctionRecord, setCorrectionRecord] = useState<FellowshipThursday | null>(null);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [correctAttendance, setCorrectAttendance] = useState(false);
  const [correctedAttended, setCorrectedAttended] = useState(false);
  const [correctSource, setCorrectSource] = useState(false);
  const [correctedSource, setCorrectedSource] = useState<SourceInfo | "">("");

  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!records.length) return;
    void supabaseBrowserClient.from("effective_fellowship_thursday").select("*").then(({ data, error }) => {
      if (error) { console.error(error); toast.error("Failed to refresh attendance records."); return; }
      if (data) setRecords(data.map((row) => ({ ...row, student: records.find((r) => r.attendance_id === row.attendance_id)?.student ?? null })) as FellowshipThursday[]);
    });
    void supabaseBrowserClient.from("fellowship_thursday_amendment").select("*, created_by:advisor!fellowship_thursday_amendment_created_by_advisor_id_fkey(advisor_name)").in("attendance_id", records.map((r) => r.attendance_id)).order("created_at", { ascending: true }).then(({ data, error }) => {
      if (error) { console.error(error); toast.error("Failed to load correction history."); return; }
      const grouped: Record<number, Amendment[]> = {};
      for (const item of data ?? []) { const a = item as unknown as Amendment; (grouped[a.attendance_id] ??= []).push(a); }
      setAmendments(grouped);
    });
  // Refresh effective values and audit trail on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const submitCorrection = async () => {
    if (!correctionRecord || !reason.trim() || (!correctAttendance && !correctSource)) return;
    setIsLoading(true);
    try {
      const { data: userData, error: userError } = await supabaseBrowserClient.auth.getUser();
      if (userError || !userData.user) throw userError ?? new Error("Sign in required");
      const { data: advisor, error: advisorError } = await supabaseBrowserClient.from("advisor").select("advisor_id").eq("auth_user_id", userData.user.id).single();
      if (advisorError) throw advisorError;
      const { error } = await supabaseBrowserClient.from("fellowship_thursday_amendment").insert({ attendance_id: correctionRecord.attendance_id, created_by_advisor_id: advisor.advisor_id, reason: reason.trim(), details: details.trim() || null, corrected_attended: correctAttendance ? correctedAttended : null, corrects_source_info: correctSource, corrected_source_info: correctSource ? correctedSource || null : null });
      if (error) throw error;
      const [effective, history] = await Promise.all([
        supabaseBrowserClient.from("effective_fellowship_thursday").select("*").eq("attendance_id", correctionRecord.attendance_id).single(),
        supabaseBrowserClient.from("fellowship_thursday_amendment").select("*, created_by:advisor!fellowship_thursday_amendment_created_by_advisor_id_fkey(advisor_name)").eq("attendance_id", correctionRecord.attendance_id).order("created_at", { ascending: true }),
      ]);
      if (effective.error) throw effective.error;
      if (history.error) throw history.error;
      setRecords((prev) => prev.map((r) => r.attendance_id === correctionRecord.attendance_id ? { ...effective.data, student: r.student } : r));
      setAmendments((prev) => ({ ...prev, [correctionRecord.attendance_id]: (history.data ?? []) as unknown as Amendment[] }));
      toast.success("Correction added to the audit trail."); setCorrectionRecord(null); setReason(""); setDetails(""); setCorrectAttendance(false); setCorrectSource(false); setCorrectedSource("");
    } catch (err) { console.error(err); toast.error("Failed to add correction."); }
    finally { setIsLoading(false); }
  };

  const resetAndCloseAdd = () => {
    setForm(EMPTY_FORM);
    setFormErrors({});
    setAddOpen(false);
  };

  const resetCorrection = () => { setCorrectionRecord(null); setReason(""); setDetails(""); setCorrectAttendance(false); setCorrectSource(false); setCorrectedSource(""); };

  const sourceLabel: Record<string, string> = { OCF: "OCF", HC: "Honors College", MM: "Mass Media" };

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
                  placeholder="Search by student name…"
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
                {(attendedFilter !== "all" || sourceFilter !== "all") && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white">•</span>
                )}
              </Button>
            </div>
            <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3 xl:flex-row xl:items-center`}>
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
          </>
        }
        trailing={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add Record
          </Button>
        }
      />

      {/* Table */}
      <AppCard>
        <AppCardContent className="p-0">
          {filteredRecords.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="No attendance records found"
              description={
                debouncedSearch || attendedFilter !== "all" || sourceFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Start tracking Thursday meeting attendance."
              }
              action={!debouncedSearch && attendedFilter === "all" && sourceFilter === "all" ? (
                <Button onClick={() => setAddOpen(true)}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Record
                </Button>
              ) : undefined}
            />
          ) : (
            <>
              {/* Mobile card list */}
              <div className="md:hidden divide-y divide-gray-200">
                {filteredRecords.map((record) => (
                  <div key={record.attendance_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900">
                          {record.student?.full_name ? (
                            <Link
                              href={`/students/${record.student_id}`}
                              className="hover:text-[#006747] hover:underline"
                            >
                              {record.student.full_name}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {record.attended ? <MetricBadge tone="green">Attended</MetricBadge> : <MetricBadge tone="red">Not Attended</MetricBadge>}
                          {record.source_info && (
                            <MetricBadge tone={record.source_info === "OCF" ? "green" : record.source_info === "HC" ? "purple" : "amber"}>
                              {sourceLabel[record.source_info] ?? record.source_info}
                            </MetricBadge>
                          )}
                        </div>
                      </div>
                    </div>
                    <RecordAudit record={record} amendments={amendments[record.attendance_id] ?? []} onCorrect={() => setCorrectionRecord(record)} sourceLabel={sourceLabel} />
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
                      Attended
                    </th>
                    <th className="hidden px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 sm:table-cell sm:px-6 sm:py-3">
                      Source
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-gray-500 sm:px-6 sm:py-3">
                      Correction history
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredRecords.map((record) => (
                    <tr
                      key={record.attendance_id}
                      className="motion-safe:transition-colors motion-safe:duration-150 hover:bg-gray-50"
                    >
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
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
                      <td className="whitespace-nowrap px-3 py-3 sm:px-6 sm:py-4">
                        {record.attended ? <MetricBadge tone="green">Yes</MetricBadge> : <MetricBadge tone="red">No</MetricBadge>}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-3 sm:table-cell sm:px-6 sm:py-4">
                        {record.source_info ? (
                          <MetricBadge tone={record.source_info === "OCF" ? "green" : record.source_info === "HC" ? "purple" : "amber"}>
                            {sourceLabel[record.source_info] ?? record.source_info}
                          </MetricBadge>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      <td className="min-w-64 px-3 py-3 sm:px-6 sm:py-4">
                        <RecordAudit record={record} amendments={amendments[record.attendance_id] ?? []} onCorrect={() => setCorrectionRecord(record)} sourceLabel={sourceLabel} />
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

      <Dialog open={correctionRecord !== null} onOpenChange={(open) => !open && resetCorrection()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Add attendance correction</DialogTitle><DialogDescription>This appends an auditable correction; the original attendance record remains unchanged.</DialogDescription></DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="ft-correction-reason">Reason <span className="text-red-600">*</span><Input id="ft-correction-reason" value={reason} onChange={(e) => setReason(e.target.value)} required aria-required="true" /></label>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="ft-correction-details">Additional details <span className="font-normal text-slate-400">(optional)</span><Input id="ft-correction-details" value={details} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDetails(e.target.value)} /></label>
            <label className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm"><input type="checkbox" checked={correctAttendance} onChange={(e) => setCorrectAttendance(e.target.checked)} className="h-4 w-4 accent-[#006747]" />Correct attendance value</label>
            {correctAttendance && <Select value={String(correctedAttended)} onValueChange={(v) => setCorrectedAttended(v === "true")}><SelectTrigger aria-label="Corrected attendance"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">Attended</SelectItem><SelectItem value="false">Not attended</SelectItem></SelectContent></Select>}
            <label className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm"><input type="checkbox" checked={correctSource} onChange={(e) => setCorrectSource(e.target.checked)} className="h-4 w-4 accent-[#006747]" />Correct source value</label>
            {correctSource && <Select value={correctedSource || "__cleared__"} onValueChange={(v) => setCorrectedSource(v === "__cleared__" ? "" : v as SourceInfo)}><SelectTrigger aria-label="Corrected source"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__cleared__">Clear source (NULL)</SelectItem>{SOURCE_OPTIONS.map((s) => <SelectItem key={s} value={s}>{sourceLabel[s]}</SelectItem>)}</SelectContent></Select>}
            {!correctAttendance && !correctSource && <p role="alert" className="text-xs text-red-600">Choose at least one value to correct.</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={resetCorrection} disabled={isLoading}>Cancel</Button><Button onClick={submitCorrection} disabled={isLoading || !reason.trim() || (!correctAttendance && !correctSource)} className="bg-[#006747] hover:bg-[#00563b]">{isLoading ? "Saving…" : "Add correction"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Shared Form Component ──────────────────────────────────────────────────

function RecordAudit({ record, amendments, onCorrect, sourceLabel }: { record: FellowshipThursday; amendments: Amendment[]; onCorrect: () => void; sourceLabel: Record<string, string> }) {
  return <div className="space-y-2 text-xs">
    <div className="text-slate-500">Original: {(record.base_attended ?? record.attended) ? "Attended" : "Not attended"} · {(record.base_source_info ?? record.source_info) ? sourceLabel[(record.base_source_info ?? record.source_info)!] ?? (record.base_source_info ?? record.source_info) : "No source"}</div>
    <div className="font-medium text-slate-700">Current: {record.attended ? "Attended" : "Not attended"} · {record.source_info ? sourceLabel[record.source_info] ?? record.source_info : "No source"}</div>
    {amendments.map((a) => <div key={a.amendment_id} className="border-l-2 border-[#006747]/30 pl-2 text-slate-500">
      <div className="font-medium text-slate-700"><History className="mr-1 inline h-3 w-3" />{a.reason}</div>
      {a.corrected_attended !== null && <div>Attendance → {a.corrected_attended ? "Attended" : "Not attended"}</div>}
      {a.corrects_source_info && <div>Source → {a.corrected_source_info ? sourceLabel[a.corrected_source_info] ?? a.corrected_source_info : "Cleared (NULL)"}</div>}
      {a.details && <div>{a.details}</div>}
      <div>{new Date(a.created_at).toLocaleString()}{a.created_by?.advisor_name ? ` · ${a.created_by.advisor_name}` : ""}</div>
    </div>)}
    <Button variant="outline" size="sm" className="h-8" onClick={onCorrect}>Add correction</Button>
  </div>;
}

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
      <label htmlFor="ft_attended" className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-gray-200 px-3 py-2 hover:bg-gray-50">
        <input
          id="ft_attended"
          type="checkbox"
          checked={form.attended}
          onChange={(e) => setForm((prev) => ({ ...prev, attended: e.target.checked }))}
          className="h-5 w-5 rounded border-gray-300 accent-[#006747]"
        />
        <span className="text-sm font-normal text-slate-700">Student attended</span>
      </label>

      {/* Source Info */}
      <div className="grid gap-1.5">
        <Label htmlFor="ft_source_info">Source</Label>
        <Select
          value={form.source_info === "" ? "__none__" : form.source_info}
          onValueChange={(v) =>
            setForm((prev) => ({ ...prev, source_info: (v === "__none__" ? "" : v) as SourceInfo | "" }))
          }
        >
          <SelectTrigger id="ft_source_info">
            <SelectValue placeholder="Select source (optional)…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— None —</SelectItem>
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
