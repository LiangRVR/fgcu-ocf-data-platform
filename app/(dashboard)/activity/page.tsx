import { Activity } from "lucide-react";
import { EntityHistory } from "@/components/history/audit-history";
import { ActivityPagination } from "@/components/history/activity-pagination";
import { createServerClient } from "@/lib/supabase/server";
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  auditActionLabel,
  auditEntityLabel,
  isAuditRow,
  type AuditActivityViewRow,
} from "@/lib/audit/presentation";
import { AUDIT_ACTIVITY_SAFE_COLUMNS, normalizeActivityRows } from "@/lib/audit/read";
import { resolveNewYorkDateRange } from "@/lib/utils/new-york-date";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";
import { redirect } from "next/navigation";

type Filters = { page?: string; pageSize?: string; entity?: string; action?: string; actor?: string; student?: string; fellowship?: string; from?: string; to?: string };
type Props = { searchParams: Promise<Filters> };
const cleanText = (value?: string) => (value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
const safeLike = (value: string) => value.replace(/[\\%_*]/g, "\\$&");

export default async function ActivityPage({ searchParams }: Props) {
  const params = await searchParams;
  const paging = resolvePagination(params);
  const entity = AUDIT_ENTITY_TYPES.find((value) => value === params.entity);
  const action = AUDIT_ACTIONS.find((value) => value === params.action);
  const actor = cleanText(params.actor), student = cleanText(params.student), fellowship = cleanText(params.fellowship);
  // OCF-office (America/New_York) calendar-day bounds: inclusive lower local
  // midnight, exclusive upper local midnight of the day AFTER `to`.
  const range = resolveNewYorkDateRange(params.from, params.to);
  const from = range.from, to = range.through;
  const supabase = createServerClient();
  // Explicit safe projection only — never `select('*')`; raw snapshot payloads
  // (`old_values`/`new_values`) never leave the database.
  let request = supabase.from("audit_activity").select<string, AuditActivityViewRow>(AUDIT_ACTIVITY_SAFE_COLUMNS, { count: "exact" });
  if (entity) request = request.eq("entity_type", entity);
  if (action) request = request.eq("action", action);
  if (actor) request = request.ilike("actor_name_snapshot", `%${safeLike(actor)}%`);
  if (student) request = request.ilike("student_name", `%${safeLike(student)}%`);
  if (fellowship) request = request.ilike("fellowship_name", `%${safeLike(fellowship)}%`);
  if (range.fromInstant) request = request.gte("occurred_at", range.fromInstant);
  if (range.throughExclusiveInstant) request = request.lt("occurred_at", range.throughExclusiveInstant);
  const { data, count, error } = await request.order("occurred_at", { ascending: false }).order("audit_id", { ascending: false }).range(paging.offset, paging.to);
  // Browser-safe view rows carry no raw JSON; the server-only raw diff is read
  // in one bounded batch from the RLS-governed `audit_event` base table and
  // parsed by the closed presentation allowlist before rendering.
  const entries = error ? [] : await normalizeActivityRows((data ?? []).filter(isAuditRow));
  const total = count ?? 0, pages = totalPages(total, paging.pageSize);
  const canonical = new URLSearchParams();
  if (entity) canonical.set("entity", entity);
  if (action) canonical.set("action", action);
  if (actor) canonical.set("actor", actor);
  if (student) canonical.set("student", student);
  if (fellowship) canonical.set("fellowship", fellowship);
  if (from) canonical.set("from", from);
  if (to) canonical.set("to", to);
  const targetPage = paging.page > Math.max(pages, 1) ? Math.max(pages, 1) : paging.page;
  const dirty = String(paging.page) !== (params.page ?? "1") || String(paging.pageSize) !== (params.pageSize ?? "25") || params.entity !== entity || params.action !== action || params.actor !== (actor || undefined) || params.student !== (student || undefined) || params.fellowship !== (fellowship || undefined) || params.from !== from || params.to !== to || targetPage !== paging.page;
  if (dirty) { canonical.set("page", String(targetPage)); canonical.set("pageSize", String(paging.pageSize)); redirect(`/activity?${canonical}`); }
  return <main className="space-y-6">
    <header className="relative overflow-hidden rounded-3xl border border-emerald-900/10 bg-gradient-to-br from-[#063d30] via-[#006747] to-[#0b7658] p-6 text-white shadow-lg sm:p-9">
      <div aria-hidden="true" className="absolute -right-12 -top-20 h-64 w-64 rounded-full border border-white/10" />
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100">Audit trail</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Activity</h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-emerald-50/85">A clear, chronological view of changes across your workspace.</p>
    </header>
    <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-sm sm:p-6" aria-label="Recent changes">
      <div className="mb-5 flex items-center gap-2 text-sm font-medium text-slate-600"><Activity className="h-4 w-4 text-[#006747]" />Workspace changes</div>
      <form className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" action="/activity">
        <label className="grid gap-1 text-xs font-medium text-slate-600">Record type<select name="entity" defaultValue={entity ?? ""} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]"><option value="">All record types</option>{AUDIT_ENTITY_TYPES.map((v) => <option key={v} value={v}>{auditEntityLabel(v)}</option>)}</select></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">Change<select name="action" defaultValue={action ?? ""} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]"><option value="">All changes</option>{AUDIT_ACTIONS.map((v) => <option key={v} value={v}>{auditActionLabel(v)}</option>)}</select></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">Actor<input name="actor" defaultValue={actor} maxLength={80} placeholder="Search actor name" className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]" /></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">Student<input name="student" defaultValue={student} maxLength={80} placeholder="Search student name" className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]" /></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">Fellowship<input name="fellowship" defaultValue={fellowship} maxLength={80} placeholder="Search fellowship" className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]" /></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">From<input name="from" type="date" defaultValue={from} className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]" /></label>
        <label className="grid gap-1 text-xs font-medium text-slate-600">Through<input name="to" type="date" defaultValue={to} className="h-10 rounded-lg border border-slate-200 px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]" /></label>
        <div className="flex items-end gap-2"><button className="h-10 rounded-lg bg-[#006747] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#00563b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747] focus-visible:ring-offset-2">Apply filters</button><a href="/activity" className="inline-flex h-10 items-center rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#006747]">Clear</a></div>
      </form>
      <EntityHistory items={entries} title="Recent changes" />
      <ActivityPagination page={paging.page} pageSize={paging.pageSize} totalCount={total} totalPages={pages} entity={entity} action={action} actor={actor} student={student} fellowship={fellowship} from={from} to={to} />
    </section>
  </main>;
}
