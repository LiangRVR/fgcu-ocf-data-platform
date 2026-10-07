"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Pagination } from "@/components/pagination/pagination";
import { updateListSearchParams } from "@/lib/utils/pagination";
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

type FellowshipThursday = Database["public"]["Views"]["fellowship_thursday_list"]["Row"] & {
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
  totalCount?: number;
  totalPages?: number;
  currentPage?: number;
  currentPageSize?: number;
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
  totalCount = initialRecords.length,
  totalPages = 1,
  currentPage = 1,
  currentPageSize = 25,
  defaultStudentId,
  autoOpenAdd,
}: FellowshipThursdayTableProps) {
  // The server is the source of truth for the current page: derive the list
  // from the prop so new pages/corrections arrive without a stale client copy.
  const records = initialRecords;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [amendments, setAmendments] = useState<Record<number, Amendment[]>>({});
  const [searchQuery, setSearchQuery] = useState(searchParams.get("search") || "");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [attendedFilter, setAttendedFilter] = useState<string>(searchParams.get("attended") || "all");
  const [sourceFilter, setSourceFilter] = useState<string>(searchParams.get("source") || "all");

  // Apply a criterion change to the canonical URL and reset to page 1. Unrelated
  // contextual parameters (add/student_id/pageSize) are preserved.
  const navigate = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const canonical = updateListSearchParams(next, { page: 1 });
    const query = canonical.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

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
  const [studentSearch, setStudentSearch] = useState("");
  const [studentOptions, setStudentOptions] = useState<StudentRow[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);
  const [studentLookupLoading, setStudentLookupLoading] = useState(false);

  // A contextual student ID is resolved individually through the authenticated
  // client (and therefore RLS), without fetching a broad selector list.
  useEffect(() => {
    if (!defaultStudentId || !/^\d+$/.test(defaultStudentId)) return;
    let active = true;
    void supabaseBrowserClient.from("student").select("student_id, full_name")
      .eq("student_id", Number(defaultStudentId)).maybeSingle().then(({ data }) => {
        if (!active || !data) return;
        const student = data as StudentRow;
        setSelectedStudent(student);
        setStudentSearch(student.full_name);
      });
    return () => { active = false; };
  }, [defaultStudentId]);

  // Search only after the user enters at least two characters. The result set
  // is deliberately bounded and relies on the caller's normal RLS policies.
  useEffect(() => {
    const term = studentSearch.trim();
    if (selectedStudent && term === selectedStudent.full_name) {
      setStudentOptions([]);
      return;
    }
    if (term.length < 2) { setStudentOptions([]); return; }
    let active = true;
    const timer = setTimeout(async () => {
      setStudentLookupLoading(true);
      const { data, error } = await supabaseBrowserClient.from("student")
        .select("student_id, full_name").ilike("full_name", `%${term}%`)
        .order("full_name").limit(20);
      if (active) {
        setStudentOptions(error ? [] : (data ?? []) as StudentRow[]);
        setStudentLookupLoading(false);
      }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [studentSearch, selectedStudent]);

  // Audit history is bounded to the attendance IDs on the current page, and
  // reloads whenever the page data changes.
  useEffect(() => {
    if (!initialRecords.length) {
      setAmendments({});
      return;
    }
    let active = true;
    void supabaseBrowserClient.from("fellowship_thursday_amendment").select("*, created_by:advisor!fellowship_thursday_amendment_created_by_advisor_id_fkey(advisor_name)").in("attendance_id", initialRecords.map((r) => r.attendance_id)).order("created_at", { ascending: true }).then(({ data, error }) => {
      if (!active) return;
      if (error) { console.error(error); toast.error("Failed to load correction history."); return; }
      const grouped: Record<number, Amendment[]> = {};
      for (const item of data ?? []) { const a = item as unknown as Amendment; (grouped[a.attendance_id] ??= []).push(a); }
      setAmendments(grouped);
    });
    return () => { active = false; };
  }, [initialRecords]);

  // Keep the controlled filters in sync with the canonical URL (Back/Forward).
  useEffect(() => {
    setSearchQuery(searchParams.get("search") ?? "");
    setAttendedFilter(searchParams.get("attended") ?? "all");
    setSourceFilter(searchParams.get("source") ?? "all");
  }, [searchParams]);

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

  // Debounce the search box, then commit it to the canonical URL (page resets).
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      if ((searchQuery ?? "") === (searchParams.get("search") ?? "")) return;
      navigate({ search: searchQuery || null });
    }, 300);
    return () => clearTimeout(timer);
  // `navigate` reads the latest URL at commit time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

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
      const { error } = await supabaseBrowserClient
        .from("fellowship_thursday")
        .insert({
          student_id: Number(form.student_id),
          attended: form.attended,
          source_info: form.source_info || null,
        });

      if (error) throw error;

      router.refresh();
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
      const { data: history, error: historyError } = await supabaseBrowserClient.from("fellowship_thursday_amendment").select("*, created_by:advisor!fellowship_thursday_amendment_created_by_advisor_id_fkey(advisor_name)").eq("attendance_id", correctionRecord.attendance_id).order("created_at", { ascending: true });
      if (historyError) throw historyError;
      // Show the appended audit entry immediately, then refresh the page so the
      // effective value comes from the security-invoker list view rather than a
      // stale client copy.
      setAmendments((prev) => ({ ...prev, [correctionRecord.attendance_id]: (history ?? []) as unknown as Amendment[] }));
      router.refresh();
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
              <Select value={attendedFilter} onValueChange={(value) => { setAttendedFilter(value); navigate({ attended: value === "all" ? null : value }); }}>
                <SelectTrigger className="w-full sm:w-36">
                  <SelectValue placeholder="All attendance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All attendance</SelectItem>
                  <SelectItem value="yes">Attended</SelectItem>
                  <SelectItem value="no">Not attended</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={(value) => { setSourceFilter(value); navigate({ source: value === "all" ? null : value }); }}>
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
          {records.length === 0 ? (
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
                {records.map((record) => (
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
                  {records.map((record) => (
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
      {records.length > 0 && (
        <div className="mt-4 text-sm text-slate-500">
          Showing <span className="font-medium">{records.length}</span>{" "}
          of <span className="font-medium">{totalCount}</span> records
        </div>
      )}
      <Pagination page={currentPage} pageSize={currentPageSize} totalCount={totalCount} totalPages={totalPages}
        getPageHref={(p) => { const next = updateListSearchParams(searchParams.toString(), { page: p }); return `${pathname}?${next.toString()}`; }}
        getPageSizeHref={(s) => { const next = updateListSearchParams(searchParams.toString(), { pageSize: s }); return `${pathname}?${next.toString()}`; }} className="mt-4" />

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
            studentSearch={studentSearch}
            setStudentSearch={(value) => { setStudentSearch(value); setSelectedStudent(null); setForm((prev) => ({ ...prev, student_id: "" })); }}
            students={studentOptions}
            loading={studentLookupLoading}
            onSelectStudent={(student) => { setSelectedStudent(student); setStudentSearch(student.full_name); setForm((prev) => ({ ...prev, student_id: String(student.student_id) })); }}
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
  studentSearch: string;
  setStudentSearch: (value: string) => void;
  loading: boolean;
  onSelectStudent: (student: StudentRow) => void;
}

function ThursdayForm({ form, setForm, formErrors, students, studentSearch, setStudentSearch, loading, onSelectStudent }: ThursdayFormProps) {
  return (
    <div className="grid gap-4 py-2">
      {/* Student */}
      <div className="grid gap-1.5">
        <Label htmlFor="ft_student_id">
          Student <span className="text-red-500">*</span>
        </Label>
        <Input id="ft_student_id" aria-label="Search students" placeholder="Type at least 2 letters to search…" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} className={formErrors.student_id ? "border-red-500" : ""} />
        {(students.length > 0 || loading || studentSearch.trim().length >= 2) && <div role="listbox" aria-label="Student results" className="max-h-36 overflow-y-auto rounded-md border">
          {loading && <p className="p-2 text-sm text-slate-500">Searching students…</p>}
          {!loading && students.map((student) => <button type="button" role="option" aria-selected={form.student_id === String(student.student_id)} key={student.student_id} className="block w-full p-2 text-left text-sm hover:bg-slate-50" onClick={() => onSelectStudent(student)}>{student.full_name}</button>)}
          {!loading && studentSearch.trim().length >= 2 && students.length === 0 && <p className="p-2 text-sm text-slate-500">No students found.</p>}
        </div>}
        {form.student_id && <p className="text-xs text-slate-500">Selected: {studentSearch}</p>}
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
