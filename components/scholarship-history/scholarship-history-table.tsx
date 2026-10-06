"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BookOpen, Plus, Search, SlidersHorizontal, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type ScholarshipHistory = Database["public"]["Tables"]["scholarship_history"]["Row"] & {
  student: { full_name: string } | null;
  fellowship: { fellowship_name: string } | null;
  effective?: Effective;
};
type StudentRow = Pick<Database["public"]["Tables"]["student"]["Row"], "student_id" | "full_name">;
type FellowshipRow = Pick<Database["public"]["Tables"]["fellowship"]["Row"], "fellowship_id" | "fellowship_name">;
type Amendment = Database["public"]["Tables"]["scholarship_history_amendment"]["Row"] & { fellowship?: { fellowship_name: string } | null };
type Effective = Database["public"]["Views"]["effective_scholarship_history"]["Row"];
interface Props {
  initialRecords: ScholarshipHistory[];
  students: StudentRow[];
  fellowships: FellowshipRow[];
  defaultStudentId?: string;
  defaultFellowshipId?: string;
  autoOpenAdd?: boolean;
}
const blank = { student_id: "", fellowship_id: "" };

export function ScholarshipHistoryTable({ initialRecords, students, fellowships, defaultStudentId, defaultFellowshipId, autoOpenAdd }: Props) {
  const [records, setRecords] = useState(initialRecords);
  const [effective, setEffective] = useState<Record<number, Effective>>(() =>
    Object.fromEntries(initialRecords.flatMap((record) => record.effective ? [[record.history_id, record.effective]] : []))
  );
  const [amendments, setAmendments] = useState<Record<number, Amendment[]>>({});
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [fellowshipFilter, setFellowshipFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [formError, setFormError] = useState("");
  const [amendTarget, setAmendTarget] = useState<ScholarshipHistory | null>(null);
  const [amendType, setAmendType] = useState<"Correction" | "Void">("Correction");
  const [reason, setReason] = useState("");
  const [correctedFellowship, setCorrectedFellowship] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (autoOpenAdd) {
      setForm({ student_id: defaultStudentId ?? "", fellowship_id: defaultFellowshipId ?? "" });
      setAddOpen(true);
    }
  // Contextual defaults are intentionally applied only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const ids = initialRecords.map((r) => r.history_id);
      if (!ids.length) return;
      const [effectiveResult, amendmentResult] = await Promise.all([
        supabaseBrowserClient.from("effective_scholarship_history").select("*").in("history_id", ids),
        supabaseBrowserClient.from("scholarship_history_amendment").select("*, fellowship:fellowship!scholarship_history_amendment_corrected_fellowship_id_fkey(fellowship_name)").in("history_id", ids).order("created_at", { ascending: true }).order("amendment_id", { ascending: true }),
      ]);
      if (!active) return;
      if (effectiveResult.error || amendmentResult.error) {
        console.error(effectiveResult.error ?? amendmentResult.error);
        toast.error("Failed to load scholarship history audit details.");
        return;
      }
      const byId: Record<number, Effective> = {};
      (effectiveResult.data ?? []).forEach((row: Effective) => { byId[row.history_id] = row; });
      const trail: Record<number, Amendment[]> = {};
      (amendmentResult.data ?? []).forEach((row: Amendment) => { (trail[row.history_id] ??= []).push(row); });
      setEffective(byId);
      setAmendments(trail);
      setRecords((current) => current.map((record) => ({ ...record, fellowship: { fellowship_name: fellowships.find((f) => f.fellowship_id === byId[record.history_id]?.fellowship_id)?.fellowship_name ?? record.fellowship?.fellowship_name ?? "—" } })));
    };
    void load();
    return () => { active = false; };
  }, [initialRecords, fellowships]);

  const filteredRecords = useMemo(() => records.filter((r) => {
    const q = debouncedSearch.toLowerCase();
    return (!q || (r.student?.full_name ?? "").toLowerCase().includes(q) || (r.fellowship?.fellowship_name ?? "").toLowerCase().includes(q)) && (fellowshipFilter === "all" || String(effective[r.history_id]?.fellowship_id ?? r.fellowship_id) === fellowshipFilter);
  }), [records, debouncedSearch, fellowshipFilter, effective]);

  const addRecord = async () => {
    if (!form.student_id || !form.fellowship_id) { setFormError("Select both a student and fellowship."); return; }
    setLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient.from("scholarship_history").insert({ student_id: Number(form.student_id), fellowship_id: Number(form.fellowship_id) }).select("*, student(full_name), fellowship(fellowship_name)").single();
      if (error) throw error;
      setRecords((prev) => [data as ScholarshipHistory, ...prev]);
      toast.success("Scholarship history record added."); setAddOpen(false); setForm(blank); setFormError("");
    } catch (err) { console.error(err); toast.error("Failed to add scholarship history record."); }
    finally { setLoading(false); }
  };
  const submitAmendment = async () => {
    if (!amendTarget) return;
    if (!reason.trim()) { setFormError("A reason is required."); return; }
    setLoading(true);
    try {
      const { data, error } = await supabaseBrowserClient.from("scholarship_history_amendment").insert({ history_id: amendTarget.history_id, amendment_type: amendType, reason: reason.trim(), corrected_fellowship_id: amendType === "Correction" && correctedFellowship ? Number(correctedFellowship) : null }).select("*, fellowship:fellowship!scholarship_history_amendment_corrected_fellowship_id_fkey(fellowship_name)").single();
      if (error) throw error;
      const row = data as Amendment;
      setAmendments((prev) => ({ ...prev, [row.history_id]: [...(prev[row.history_id] ?? []), row] }));
      const { data: viewRow, error: viewError } = await supabaseBrowserClient.from("effective_scholarship_history").select("*").eq("history_id", row.history_id).single();
      if (viewError) throw viewError;
      const view = viewRow as Effective;
      setEffective((prev) => ({ ...prev, [view.history_id]: view }));
      const name = fellowships.find((f) => f.fellowship_id === view.fellowship_id)?.fellowship_name;
      if (name) setRecords((prev) => prev.map((r) => r.history_id === view.history_id ? { ...r, fellowship: { fellowship_name: name } } : r));
      toast.success(amendType === "Void" ? "Award record voided." : "Correction added.");
      setAmendTarget(null); setReason(""); setCorrectedFellowship(""); setFormError("");
    } catch (err) { console.error(err); toast.error("Failed to save amendment."); }
    finally { setLoading(false); }
  };

  return <>
    <DataToolbar className="mb-4" leading={<>
      <div className="flex items-center gap-2"><div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input aria-label="Search by student or fellowship" placeholder="Search by student or fellowship…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" /></div><Button variant="outline" size="sm" className="shrink-0 gap-1.5 xl:hidden" onClick={() => setFiltersOpen((v) => !v)}><SlidersHorizontal className="h-4 w-4" />Filters</Button></div>
      <div className={`${filtersOpen ? "flex" : "hidden xl:flex"} flex-wrap gap-3`}><Select value={fellowshipFilter} onValueChange={setFellowshipFilter}><SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="All fellowships" /></SelectTrigger><SelectContent><SelectItem value="all">All fellowships</SelectItem>{fellowships.map((f) => <SelectItem key={f.fellowship_id} value={String(f.fellowship_id)}>{f.fellowship_name}</SelectItem>)}</SelectContent></Select></div>
    </>} trailing={<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="mr-2 h-4 w-4" />Add Record</Button>} />
    <AppCard><AppCardContent className="p-0">{filteredRecords.length === 0 ? <EmptyState icon={BookOpen} title="No scholarship history found" description={debouncedSearch || fellowshipFilter !== "all" ? "Try adjusting your search or filter." : "Start recording prior scholarship and fellowship awards."} action={!debouncedSearch && fellowshipFilter === "all" ? <Button onClick={() => setAddOpen(true)}><Plus className="mr-2 h-4 w-4" />Add Record</Button> : undefined} /> : <div className="divide-y divide-gray-200">
      {filteredRecords.map((record) => { const view = effective[record.history_id]; const voided = view?.is_voided ?? false; const trail = amendments[record.history_id] ?? []; return <article key={record.history_id} className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><Link href={`/students/${record.student_id}`} className="font-medium text-slate-900 hover:text-[#006747] hover:underline">{record.student?.full_name ?? "—"}</Link><div className="mt-1 text-sm text-slate-600"><Link href={`/fellowships/${view?.fellowship_id ?? record.fellowship_id}`} className="hover:text-[#006747] hover:underline">{record.fellowship?.fellowship_name ?? "—"}</Link>{view?.has_correction && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">Corrected</span>}</div><p className="mt-1 text-xs text-slate-500">Original award record · #{record.history_id}</p></div>
          <div className="flex flex-wrap items-center gap-2">{voided && <span role="status" className="rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">Voided award</span>}{!voided && <><Button variant="outline" size="sm" onClick={() => { setAmendType("Correction"); setAmendTarget(record); setFormError(""); }}>Add Correction</Button><Button variant="outline" size="sm" className="border-red-200 text-red-700 hover:bg-red-50" onClick={() => { setAmendType("Void"); setAmendTarget(record); setFormError(""); }}>Void Award Record</Button></>}</div>
        </div>
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:p-4"><h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><ScrollText className="h-4 w-4" />Audit trail <span className="font-normal normal-case">({trail.length} {trail.length === 1 ? "amendment" : "amendments"})</span></h3>{trail.length === 0 ? <p className="mt-2 text-sm text-slate-500">No corrections or voids recorded.</p> : <ol className="mt-3 space-y-3">{trail.map((item) => <li key={item.amendment_id} className="border-l-2 border-[#006747]/30 pl-3"><div className="flex flex-wrap items-center gap-2"><span className={`text-sm font-semibold ${item.amendment_type === "Void" ? "text-red-700" : "text-slate-800"}`}>{item.amendment_type === "Void" ? "Award voided" : "Correction"}</span><time className="text-xs text-slate-500">{new Date(item.created_at).toLocaleString()}</time></div>{item.corrected_fellowship_id && <p className="mt-1 text-sm text-slate-600">Corrected fellowship: {item.fellowship?.fellowship_name ?? fellowships.find((f) => f.fellowship_id === item.corrected_fellowship_id)?.fellowship_name ?? "—"}</p>}<p className="mt-1 text-sm text-slate-700">{item.reason}</p>{item.details && <p className="mt-1 text-sm text-slate-500">{item.details}</p>}</li>)}</ol>}</div>
      </article>; })}
    </div>}</AppCardContent></AppCard>
    {filteredRecords.length > 0 && <div className="mt-4 text-sm text-slate-500">Showing <span className="font-medium">{filteredRecords.length}</span> of <span className="font-medium">{records.length}</span> records</div>}

    <Dialog open={addOpen} onOpenChange={(open) => { if (!open && !loading) { setAddOpen(false); setForm(blank); setFormError(""); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Add Scholarship History</DialogTitle><DialogDescription>Record a prior scholarship or fellowship award for a student.</DialogDescription></DialogHeader><div className="grid gap-4 py-2"><div className="grid gap-1.5"><Label htmlFor="sh_student_id">Student <span className="text-red-500">*</span></Label><Select value={form.student_id} onValueChange={(v) => setForm((p) => ({ ...p, student_id: v }))}><SelectTrigger id="sh_student_id"><SelectValue placeholder="Select a student…" /></SelectTrigger><SelectContent>{students.map((s) => <SelectItem key={s.student_id} value={String(s.student_id)}>{s.full_name}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1.5"><Label htmlFor="sh_fellowship_id">Fellowship / Scholarship <span className="text-red-500">*</span></Label><Select value={form.fellowship_id} onValueChange={(v) => setForm((p) => ({ ...p, fellowship_id: v }))}><SelectTrigger id="sh_fellowship_id"><SelectValue placeholder="Select a fellowship…" /></SelectTrigger><SelectContent>{fellowships.map((f) => <SelectItem key={f.fellowship_id} value={String(f.fellowship_id)}>{f.fellowship_name}</SelectItem>)}</SelectContent></Select></div>{formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)} disabled={loading}>Cancel</Button><Button onClick={addRecord} disabled={loading} className="bg-[#006747] hover:bg-[#00563b]">{loading ? "Saving…" : "Add Record"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={amendTarget !== null} onOpenChange={(open) => { if (!open && !loading) { setAmendTarget(null); setReason(""); setCorrectedFellowship(""); setFormError(""); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{amendType === "Void" ? "Void Award Record" : "Add Correction"}</DialogTitle><DialogDescription>{amendType === "Void" ? "This award will remain in the audit trail but be excluded from effective award records. Voiding is permanent." : "Append a factual correction to this original award. The original record will remain unchanged."}</DialogDescription></DialogHeader><div className="grid gap-4 py-2"><div className="grid gap-1.5"><Label htmlFor="amendment_reason">Reason <span className="text-red-500">*</span></Label><textarea id="amendment_reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain why this change is needed…" aria-required="true" className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50" /></div>{amendType === "Correction" && <div className="grid gap-1.5"><Label htmlFor="corrected_fellowship">Corrected fellowship <span className="text-xs font-normal text-slate-500">(optional)</span></Label><Select value={correctedFellowship} onValueChange={setCorrectedFellowship}><SelectTrigger id="corrected_fellowship"><SelectValue placeholder="No fellowship change" /></SelectTrigger><SelectContent>{fellowships.map((f) => <SelectItem key={f.fellowship_id} value={String(f.fellowship_id)}>{f.fellowship_name}</SelectItem>)}</SelectContent></Select><p className="text-xs text-slate-500">Leave blank if the award program does not need correction.</p></div>}{formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setAmendTarget(null)} disabled={loading}>Cancel</Button><Button onClick={submitAmendment} disabled={loading} className={amendType === "Void" ? "bg-red-700 hover:bg-red-800" : "bg-[#006747] hover:bg-[#00563b]"}>{loading ? "Saving…" : amendType === "Void" ? "Void Award Record" : "Add Correction"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
