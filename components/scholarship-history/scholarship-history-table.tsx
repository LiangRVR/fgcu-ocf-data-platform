"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Plus, Search, SlidersHorizontal, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";
import { Pagination } from "@/components/pagination/pagination";
import { updateListSearchParams } from "@/lib/utils/pagination";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type ScholarshipHistoryListRow = Database["public"]["Views"]["scholarship_history_list"]["Row"];

type ScholarshipHistory = ScholarshipHistoryListRow & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
  effective?: Effective;
  amendments?: Amendment[];
};
type StudentRow = Pick<Database["public"]["Tables"]["student"]["Row"], "student_id" | "full_name">;
type FellowshipRow = Pick<Database["public"]["Tables"]["fellowship"]["Row"], "fellowship_id" | "fellowship_name">;
type Amendment = Database["public"]["Tables"]["scholarship_history_amendment"]["Row"] & { fellowship?: { fellowship_name: string } | null };
/** Effective award state; both the list view and the effective view satisfy it. */
type Effective = Pick<ScholarshipHistoryListRow, "history_id" | "fellowship_id" | "has_correction" | "is_voided">;
interface Props {
  initialRecords: ScholarshipHistory[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
  currentPageSize: number;
  defaultStudentId?: string;
  defaultFellowshipId?: string;
  autoOpenAdd?: boolean;
}
const blank = { student_id: "", fellowship_id: "" };

interface LookupOption {
  value: string;
  label: string;
}

const toStudentOption = (student: StudentRow): LookupOption => ({
  value: String(student.student_id),
  label: student.full_name,
});
const toFellowshipOption = (fellowship: FellowshipRow): LookupOption => ({
  value: String(fellowship.fellowship_id),
  label: fellowship.fellowship_name,
});

/** Escape LIKE wildcards so a literal search term cannot widen its match set. */
const escapeLike = (value: string) => value.replace(/[%_\\]/g, "\\$&");

interface LookupFieldProps {
  id: string;
  label: string;
  searchLabel: string;
  placeholder: string;
  term: string;
  onTermChange: (value: string) => void;
  options: LookupOption[];
  selectedValue?: string;
  onSelect: (option: LookupOption) => void;
  selectedLabel?: string;
  onClear?: () => void;
  loading?: boolean;
  emptyNoun: string;
  required?: boolean;
  optionalHint?: string;
}

/**
 * Bounded, RLS-scoped typeahead for an Add/Correction control. Options are only
 * requested (limit 20) once the user types at least two characters, so forms
 * never load a full selector table as a side effect of list browsing.
 */
function LookupField({
  id,
  label,
  searchLabel,
  placeholder,
  term,
  onTermChange,
  options,
  selectedValue,
  onSelect,
  selectedLabel,
  onClear,
  loading,
  emptyNoun,
  required,
  optionalHint,
}: LookupFieldProps) {
  const searching = term.trim().length >= 2;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label} {required && <span className="text-red-500">*</span>}
        {optionalHint && <span className="text-xs font-normal text-slate-500"> {optionalHint}</span>}
      </Label>
      <Input
        id={id}
        aria-label={searchLabel}
        placeholder={placeholder}
        value={term}
        onChange={(event) => onTermChange(event.target.value)}
      />
      {options.length > 0 && (
        <div role="listbox" aria-label={`${label} results`} className="max-h-36 overflow-y-auto rounded-md border">
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={selectedValue === option.value}
              key={option.value}
              className="block w-full p-2 text-left text-sm hover:bg-slate-50"
              onClick={() => onSelect(option)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {searching && !loading && options.length === 0 && !selectedLabel && (
        <p className="text-xs text-slate-500">No matching {emptyNoun}.</p>
      )}
      {selectedLabel && (
        <p className="text-xs text-slate-500">
          Selected: {selectedLabel}
          {onClear && (
            <button type="button" className="ml-2 text-[#006747] hover:underline" onClick={onClear}>
              Clear
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function trailsFromRecords(records: ScholarshipHistory[]): Record<number, Amendment[]> {
  const trail: Record<number, Amendment[]> = {};
  for (const record of records) {
    if (record.amendments?.length) trail[record.history_id] = record.amendments;
  }
  return trail;
}

export function ScholarshipHistoryTable({
  initialRecords,
  totalCount,
  totalPages,
  currentPage,
  currentPageSize,
  defaultStudentId,
  defaultFellowshipId,
  autoOpenAdd,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [records, setRecords] = useState(initialRecords);
  const [effective, setEffective] = useState<Record<number, Effective>>(() =>
    Object.fromEntries(initialRecords.flatMap((record) => record.effective ? [[record.history_id, record.effective]] : []))
  );
  const [amendments, setAmendments] = useState<Record<number, Amendment[]>>(() =>
    trailsFromRecords(initialRecords)
  );
  const [search, setSearch] = useState(searchParams.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get("search") ?? "");
  const [fellowshipFilter, setFellowshipFilter] = useState(searchParams.get("fellowship_id") ?? "all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [formError, setFormError] = useState("");
  const [amendTarget, setAmendTarget] = useState<ScholarshipHistory | null>(null);
  const [amendType, setAmendType] = useState<"Correction" | "Void">("Correction");
  const [reason, setReason] = useState("");
  const [correctedFellowship, setCorrectedFellowship] = useState("");
  const [loading, setLoading] = useState(false);
  const [studentTerm, setStudentTerm] = useState("");
  const [fellowshipTerm, setFellowshipTerm] = useState("");
  const [studentOptions, setStudentOptions] = useState<StudentRow[]>([]);
  const [fellowshipOptions, setFellowshipOptions] = useState<FellowshipRow[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentRow | null>(null);
  const [selectedFellowship, setSelectedFellowship] = useState<FellowshipRow | null>(null);
  const [studentLookupLoading, setStudentLookupLoading] = useState(false);
  const [fellowshipLookupLoading, setFellowshipLookupLoading] = useState(false);
  const [filterTerm, setFilterTerm] = useState("");
  const [filterOptions, setFilterOptions] = useState<FellowshipRow[]>([]);
  const [filterLabel, setFilterLabel] = useState("");

  // Bounded Add student lookup. Only queried while the Add dialog is open and
  // the user has typed at least two characters; never on normal list browsing.
  useEffect(() => {
    if (!addOpen) return;
    const term = studentTerm.trim();
    if (selectedStudent && term === selectedStudent.full_name) { setStudentOptions([]); return; }
    if (term.length < 2) { setStudentOptions([]); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      setStudentLookupLoading(true);
      const { data, error } = await supabaseBrowserClient.from("student").select("student_id,full_name")
        .is("archived_at", null).ilike("full_name", `%${escapeLike(term)}%`).order("full_name").limit(20);
      if (alive) {
        setStudentOptions(error ? [] : (data ?? []) as StudentRow[]);
        setStudentLookupLoading(false);
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [addOpen, studentTerm, selectedStudent]);

  // Bounded fellowship lookup shared by the Add and Correction dialogs.
  useEffect(() => {
    if (!addOpen && !(amendTarget && amendType === "Correction")) return;
    const term = fellowshipTerm.trim();
    if (selectedFellowship && term === selectedFellowship.fellowship_name) { setFellowshipOptions([]); return; }
    if (term.length < 2) { setFellowshipOptions([]); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      setFellowshipLookupLoading(true);
      const { data, error } = await supabaseBrowserClient.from("fellowship").select("fellowship_id,fellowship_name")
        .ilike("fellowship_name", `%${escapeLike(term)}%`).order("fellowship_name").limit(20);
      if (alive) {
        setFellowshipOptions(error ? [] : (data ?? []) as FellowshipRow[]);
        setFellowshipLookupLoading(false);
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [addOpen, amendTarget, amendType, fellowshipTerm, selectedFellowship]);

  // Bounded fellowship filter lookup. Deferred until the user searches, so a
  // plain list visit makes no selector-table query.
  useEffect(() => {
    const term = filterTerm.trim();
    if (filterLabel && term === filterLabel) { setFilterOptions([]); return; }
    if (term.length < 2) { setFilterOptions([]); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      const { data, error } = await supabaseBrowserClient.from("fellowship").select("fellowship_id,fellowship_name")
        .ilike("fellowship_name", `%${escapeLike(term)}%`).order("fellowship_name").limit(20);
      if (alive) {
        setFilterOptions(error ? [] : (data ?? []) as FellowshipRow[]);
      }
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [filterTerm, filterLabel]);

  // Reflect an active (possibly bookmarked) fellowship filter by resolving its
  // label through one RLS-scoped single-row lookup rather than a selector list.
  useEffect(() => {
    if (fellowshipFilter === "all" || !/^\d+$/.test(fellowshipFilter)) { setFilterLabel(""); return; }
    let alive = true;
    void supabaseBrowserClient.from("fellowship").select("fellowship_id,fellowship_name")
      .eq("fellowship_id", Number(fellowshipFilter)).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return;
        const fellowship = data as FellowshipRow;
        setFilterLabel(fellowship.fellowship_name);
        setFilterTerm(fellowship.fellowship_name);
      });
    return () => { alive = false; };
  }, [fellowshipFilter]);

  // Contextual Add prefill: resolve the incoming IDs to display names through
  // bounded single-row lookups instead of eagerly loading selector tables.
  useEffect(() => {
    if (!autoOpenAdd || !defaultStudentId || !/^\d+$/.test(defaultStudentId)) return;
    let alive = true;
    void supabaseBrowserClient.from("student").select("student_id,full_name")
      .eq("student_id", Number(defaultStudentId)).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return;
        const student = data as StudentRow;
        setSelectedStudent(student);
        setStudentTerm(student.full_name);
      });
    return () => { alive = false; };
  }, [autoOpenAdd, defaultStudentId]);

  useEffect(() => {
    if (!autoOpenAdd || !defaultFellowshipId || !/^\d+$/.test(defaultFellowshipId)) return;
    let alive = true;
    void supabaseBrowserClient.from("fellowship").select("fellowship_id,fellowship_name")
      .eq("fellowship_id", Number(defaultFellowshipId)).maybeSingle()
      .then(({ data }) => {
        if (!alive || !data) return;
        const fellowship = data as FellowshipRow;
        setSelectedFellowship(fellowship);
        setFellowshipTerm(fellowship.fellowship_name);
      });
    return () => { alive = false; };
  }, [autoOpenAdd, defaultFellowshipId]);

  useEffect(() => {
    if (autoOpenAdd) {
      setForm({ student_id: defaultStudentId ?? "", fellowship_id: defaultFellowshipId ?? "" });
      setAddOpen(true);
    }
  // Contextual defaults are intentionally applied only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep local state aligned with the server page after a navigation/refresh.
  useEffect(() => {
    setRecords(initialRecords);
    setEffective(Object.fromEntries(initialRecords.flatMap((record) => record.effective ? [[record.history_id, record.effective]] : [])));
    setAmendments(trailsFromRecords(initialRecords));
  }, [initialRecords]);

  // Commit user search changes to canonical URL state (resets to page 1).
  // The guard keeps a bookmarked `?search=…&page=N` from resetting on mount.
  useEffect(() => {
    if (search === (searchParams.get("search") ?? "")) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      const next = updateListSearchParams(searchParams.toString(), { search: search || null });
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const changeFellowshipFilter = (value: string) => {
    setFellowshipFilter(value);
    const next = new URLSearchParams(searchParams.toString());
    if (value === "all") next.delete("fellowship_id");
    else next.set("fellowship_id", value);
    // `filter` is the legacy key; canonical state is `fellowship_id`.
    next.delete("filter");
    next.delete("page");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const resetAdd = () => {
    setForm(blank);
    setFormError("");
    setSelectedStudent(null);
    setStudentTerm("");
    setStudentOptions([]);
    setSelectedFellowship(null);
    setFellowshipTerm("");
    setFellowshipOptions([]);
  };

  const openAdd = () => {
    resetAdd();
    setAddOpen(true);
  };

  const changeStudentTerm = (value: string) => {
    setStudentTerm(value);
    if (selectedStudent && value !== selectedStudent.full_name) {
      setSelectedStudent(null);
      setForm((prev) => ({ ...prev, student_id: "" }));
    }
  };

  const changeFellowshipTerm = (value: string) => {
    setFellowshipTerm(value);
    if (selectedFellowship && value !== selectedFellowship.fellowship_name) {
      setSelectedFellowship(null);
      setForm((prev) => ({ ...prev, fellowship_id: "" }));
      setCorrectedFellowship("");
    }
  };

  const selectStudent = (option: LookupOption) => {
    const student = studentOptions.find((row) => String(row.student_id) === option.value) ?? null;
    setSelectedStudent(student);
    setStudentTerm(option.label);
    setStudentOptions([]);
    setForm((prev) => ({ ...prev, student_id: option.value }));
    setFormError("");
  };

  const selectFellowship = (option: LookupOption) => {
    const fellowship = fellowshipOptions.find((row) => String(row.fellowship_id) === option.value) ?? null;
    setSelectedFellowship(fellowship);
    setFellowshipTerm(option.label);
    setFellowshipOptions([]);
    setForm((prev) => ({ ...prev, fellowship_id: option.value }));
    setFormError("");
  };

  const selectCorrectedFellowship = (option: LookupOption) => {
    const fellowship = fellowshipOptions.find((row) => String(row.fellowship_id) === option.value) ?? null;
    setSelectedFellowship(fellowship);
    setFellowshipTerm(option.label);
    setFellowshipOptions([]);
    setCorrectedFellowship(option.value);
    setFormError("");
  };

  const selectFilterFellowship = (option: LookupOption) => {
    setFilterLabel(option.label);
    setFilterTerm(option.label);
    setFilterOptions([]);
    changeFellowshipFilter(option.value);
  };

  const clearFellowshipFilter = () => {
    setFilterLabel("");
    setFilterTerm("");
    setFilterOptions([]);
    changeFellowshipFilter("all");
  };

  const openAmendment = (record: ScholarshipHistory, type: "Correction" | "Void") => {
    setAmendType(type);
    setAmendTarget(record);
    setFormError("");
    setCorrectedFellowship("");
    setSelectedFellowship(null);
    setFellowshipTerm("");
    setFellowshipOptions([]);
  };

  const addRecord = async () => {
    if (!form.student_id || !form.fellowship_id) { setFormError("Select both a student and fellowship."); return; }
    setLoading(true);
    try {
      const { error } = await supabaseBrowserClient.from("scholarship_history").insert({ student_id: Number(form.student_id), fellowship_id: Number(form.fellowship_id) });
      if (error) throw error;
      toast.success("Scholarship history record added."); setAddOpen(false); resetAdd();
      // Re-run the server loader so the visible page, active filters, deterministic
      // order, exact count and operational summary all reflect the new row instead
      // of optimistically splicing it into a possibly partial/stale page.
      router.refresh();
    } catch (err) { console.error(err); toast.error("Failed to add scholarship history record."); }
    finally { setLoading(false); }
  };
  const submitAmendment = async () => {
    if (!amendTarget) return;
    if (!reason.trim()) { setFormError("A reason is required."); return; }
    setLoading(true);
    try {
      const { error } = await supabaseBrowserClient.from("scholarship_history_amendment").insert({ history_id: amendTarget.history_id, amendment_type: amendType, reason: reason.trim(), corrected_fellowship_id: amendType === "Correction" && correctedFellowship ? Number(correctedFellowship) : null });
      if (error) throw error;
      toast.success(amendType === "Void" ? "Award record voided." : "Correction added.");
      setAmendTarget(null); setReason(""); setCorrectedFellowship(""); setFormError("");
      setSelectedFellowship(null); setFellowshipTerm(""); setFellowshipOptions([]);
      // The corrected/voided effective values and audit trail are server-derived
      // (effective_scholarship_history + bounded amendment query): refresh so the
      // list never displays a client-authoritative override.
      router.refresh();
    } catch (err) { console.error(err); toast.error("Failed to save amendment."); }
    finally { setLoading(false); }
  };

  return <>
    <DataToolbar className="mb-4" leading={<>
      <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input aria-label="Search by student or fellowship" placeholder="Search by student or fellowship…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" /></div><Button variant="outline" size="sm" className="shrink-0 gap-1.5 xl:hidden" onClick={() => setFiltersOpen((v) => !v)}><SlidersHorizontal className="h-4 w-4" />Filters</Button></div>
      <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap items-center gap-3`}>
        <div className="relative w-full sm:w-48">
          <Input aria-label="Filter by fellowship" placeholder="Filter by fellowship…" value={filterTerm} onChange={(e) => setFilterTerm(e.target.value)} />
          {filterOptions.length > 0 && (
            <div role="listbox" aria-label="Fellowship filter results" className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-white shadow-md">
              <button type="button" role="option" aria-selected={fellowshipFilter === "all"} className="block w-full p-2 text-left text-sm hover:bg-slate-50" onClick={clearFellowshipFilter}>All fellowships</button>
              {filterOptions.map((f) => <button type="button" role="option" aria-selected={fellowshipFilter === String(f.fellowship_id)} key={f.fellowship_id} className="block w-full p-2 text-left text-sm hover:bg-slate-50" onClick={() => selectFilterFellowship(toFellowshipOption(f))}>{f.fellowship_name}</button>)}
            </div>
          )}
        </div>
        {fellowshipFilter !== "all" && <Button variant="outline" size="sm" className="shrink-0" onClick={clearFellowshipFilter}>Clear filter</Button>}
      </div>
    </>} trailing={<Button size="sm" onClick={openAdd}><Plus className="mr-2 h-4 w-4" />Add Record</Button>} />
    <AppCard><AppCardContent className="p-0">{records.length === 0 ? <EmptyState icon={BookOpen} title="No scholarship history found" description={debouncedSearch || fellowshipFilter !== "all" ? "Try adjusting your search or filter." : "Start recording prior scholarship and fellowship awards."} action={!debouncedSearch && fellowshipFilter === "all" ? <Button onClick={openAdd}><Plus className="mr-2 h-4 w-4" />Add Record</Button> : undefined} /> : <div className="divide-y divide-gray-200">
      {records.map((record) => { const view = effective[record.history_id]; const voided = view?.is_voided ?? false; const trail = amendments[record.history_id] ?? []; return <article key={record.history_id} className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><Link href={`/students/${record.student_id}`} className="font-medium text-slate-900 hover:text-[#006747] hover:underline">{record.student?.full_name ?? "—"}</Link><div className="mt-1 text-sm text-slate-600"><Link href={`/fellowships/${view?.fellowship_id ?? record.fellowship_id}`} className="hover:text-[#006747] hover:underline">{record.fellowship?.fellowship_name ?? "—"}</Link>{view?.has_correction && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">Corrected</span>}</div><p className="mt-1 text-xs text-slate-500">Original award record · #{record.history_id}</p></div>
          <div className="flex flex-wrap items-center gap-2">{voided && <span role="status" className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">Voided award</span>}{!voided && <><Button variant="outline" size="sm" onClick={() => openAmendment(record, "Correction")}>Add Correction</Button><Button variant="outline" size="sm" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => openAmendment(record, "Void")}>Void Award Record</Button></>}</div>
        </div>
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:p-4"><h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><ScrollText className="h-4 w-4" />Audit trail <span className="font-normal normal-case">({trail.length} {trail.length === 1 ? "amendment" : "amendments"})</span></h3>{trail.length === 0 ? <p className="mt-2 text-sm text-slate-500">No corrections or voids recorded.</p> : <ol className="mt-3 space-y-3">{trail.map((item) => <li key={item.amendment_id} className="border-l-2 border-[#006747]/30 pl-3"><div className="flex flex-wrap items-center gap-2"><span className={`text-sm font-semibold ${item.amendment_type === "Void" ? "text-red-700" : "text-slate-800"}`}>{item.amendment_type === "Void" ? "Award voided" : "Correction"}</span><time className="text-xs text-slate-500">{new Date(item.created_at).toLocaleString()}</time></div>{item.corrected_fellowship_id && <p className="mt-1 text-sm text-slate-600">Corrected fellowship: {item.fellowship?.fellowship_name ?? "—"}</p>}<p className="mt-1 text-sm text-slate-700">{item.reason}</p>{item.details && <p className="mt-1 text-sm text-slate-500">{item.details}</p>}</li>)}</ol>}</div>
      </article>; })}
    </div>}</AppCardContent></AppCard>
    <Pagination page={currentPage} pageSize={currentPageSize} totalCount={totalCount} totalPages={totalPages}
      getPageHref={(p) => { const next = updateListSearchParams(searchParams.toString(), { page: p }); const query = next.toString(); return query ? `${pathname}?${query}` : pathname; }}
      getPageSizeHref={(s) => { const next = updateListSearchParams(searchParams.toString(), { pageSize: s }); const query = next.toString(); return query ? `${pathname}?${query}` : pathname; }} className="mt-4" />

    <Dialog open={addOpen} onOpenChange={(open) => { if (!open && !loading) { setAddOpen(false); resetAdd(); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Add Scholarship History</DialogTitle><DialogDescription>Record a prior scholarship or fellowship award for a student.</DialogDescription></DialogHeader><div className="grid gap-4 py-2"><LookupField id="sh_student_id" label="Student" searchLabel="Search students" required placeholder="Type at least 2 letters to search…" term={studentTerm} onTermChange={changeStudentTerm} options={studentOptions.map(toStudentOption)} selectedValue={form.student_id} onSelect={selectStudent} selectedLabel={selectedStudent?.full_name} loading={studentLookupLoading} emptyNoun="students" /><LookupField id="sh_fellowship_id" label="Fellowship / Scholarship" searchLabel="Search fellowships" required placeholder="Type at least 2 letters to search…" term={fellowshipTerm} onTermChange={changeFellowshipTerm} options={fellowshipOptions.map(toFellowshipOption)} selectedValue={form.fellowship_id} onSelect={selectFellowship} selectedLabel={selectedFellowship?.fellowship_name} loading={fellowshipLookupLoading} emptyNoun="fellowships" />{formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)} disabled={loading}>Cancel</Button><Button onClick={addRecord} disabled={loading} className="bg-[#006747] hover:bg-[#00563b]">{loading ? "Saving…" : "Add Record"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={amendTarget !== null} onOpenChange={(open) => { if (!open && !loading) { setAmendTarget(null); setReason(""); setCorrectedFellowship(""); setFormError(""); setSelectedFellowship(null); setFellowshipTerm(""); setFellowshipOptions([]); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{amendType === "Void" ? "Void Award Record" : "Add Correction"}</DialogTitle><DialogDescription>{amendType === "Void" ? "This award will remain in the audit trail but be excluded from effective award records. Voiding is permanent." : "Append a factual correction to this original award. The original record will remain unchanged."}</DialogDescription></DialogHeader><div className="grid gap-4 py-2"><div className="grid gap-1.5"><Label htmlFor="amendment_reason">Reason <span className="text-red-500">*</span></Label><textarea id="amendment_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain why this change is needed…" aria-required="true" className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" /></div>{amendType === "Correction" && <div className="grid gap-1.5"><LookupField id="corrected_fellowship" label="Corrected fellowship" optionalHint="(optional)" searchLabel="Search corrected fellowships" placeholder="Type at least 2 letters to search…" term={fellowshipTerm} onTermChange={changeFellowshipTerm} options={fellowshipOptions.map(toFellowshipOption)} selectedValue={correctedFellowship} onSelect={selectCorrectedFellowship} selectedLabel={selectedFellowship?.fellowship_name} onClear={() => { setCorrectedFellowship(""); setSelectedFellowship(null); setFellowshipTerm(""); }} loading={fellowshipLookupLoading} emptyNoun="fellowships" /><p className="text-xs text-slate-500">Leave blank if the award program does not need correction.</p></div>}{formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setAmendTarget(null)} disabled={loading}>Cancel</Button><Button onClick={submitAmendment} disabled={loading} className={amendType === "Void" ? "bg-red-700 hover:bg-red-800" : "bg-[#006747] hover:bg-[#00563b]"}>{loading ? "Saving…" : amendType === "Void" ? "Void Award Record" : "Add Correction"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
