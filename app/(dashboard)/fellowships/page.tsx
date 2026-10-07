import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { AddFellowshipButton } from "@/components/fellowships/add-fellowship-button";
import { FellowshipsTable } from "@/components/fellowships/fellowships-table";
import { createServerClient } from "@/lib/supabase/server";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";
import type { Database } from "@/types/database";

export const metadata: Metadata = { title: "Fellowships" };
type Row = Database["public"]["Views"]["fellowship_list"]["Row"];
type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function canonical(params: Params, normalized: {page:number;pageSize:number}, view: string, search: string, sort: string) {
  const query = new URLSearchParams();
  if (view !== "all") query.set("view", view);
  if (search) query.set("search", search);
  if (sort !== "fellowship_name") query.set("sort", sort);
  if (normalized.page !== 1) query.set("page", String(normalized.page));
  if (normalized.pageSize !== 25) query.set("pageSize", String(normalized.pageSize));
  return query.size ? `/fellowships?${query}` : "/fellowships";
}

export default async function FellowshipsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  const view = one(raw.view) ?? "all";
  const safeView = ["all", "archived", "no-applicants"].includes(view) ? view : "all";
  const search = (one(raw.search) ?? "").trim();
  const sort = one(raw.sort) ?? "fellowship_name";
  const safeSort = ["fellowship_name", "fellowship_id"].includes(sort) ? sort : "fellowship_name";
  const pagination = resolvePagination({ page: one(raw.page), pageSize: one(raw.pageSize) });
  const expected = canonical(raw, pagination, safeView, search, safeSort);
  const supplied = new URLSearchParams(Object.entries(raw).flatMap(([k,v]) => v === undefined ? [] : Array.isArray(v) ? v.map(x=>[k,x]) : [[k,v]])).toString();
  const suppliedUrl = supplied ? `/fellowships?${supplied}` : "/fellowships";
  if (view !== safeView || sort !== safeSort || suppliedUrl !== expected) redirect(expected);

  const db = createServerClient();
  let query = db.from("fellowship_list").select("*", { count: "exact" });
  if (safeView === "archived") query = query.not("archived_at", "is", null);
  else query = query.is("archived_at", null);
  if (safeView === "no-applicants") query = query.eq("has_applications", false);
  if (search) query = query.ilike("fellowship_name", `%${search.replace(/[\%_]/g, "\\$&")}%`);
  query = query.order(safeSort, { ascending: true }).order("fellowship_id", { ascending: true });
  const { data, count, error } = await query.range(pagination.offset, pagination.to);
  if (error) throw new Error("Unable to load fellowships");
  const total = count ?? 0;
  const pages = totalPages(total, pagination.pageSize);
  // An out-of-range page canonicalizes to the last valid page, or to page 1
  // when the exact total is zero. Redirecting rewrites the URL; no second
  // bounded replacement query is issued from this render.
  if (pagination.page > Math.max(1, pages)) redirect(canonical(raw, { ...pagination, page: Math.max(1, pages) }, safeView, search, safeSort));
  return <>
    <PageHeader eyebrow="Program Portfolio" title="Fellowships" description="Manage fellowship opportunities and review application activity."><AddFellowshipButton /></PageHeader>
    <nav className="mb-6 flex flex-wrap gap-2" aria-label="Fellowship views">
      {([ ["all","Active Fellowships"], ["archived","Archived Fellowships"], ["no-applicants","No Applicants Yet"] ] as const).map(([key,label]) => <a key={key} href={key === "all" ? "/fellowships" : `/fellowships?view=${key}`} className={`rounded-full border px-3 py-1.5 text-xs font-medium ${safeView === key ? "border-slate-900 bg-slate-900 text-white" : "border-border bg-white text-slate-600"}`}>{label}</a>)}
    </nav>
    <FellowshipsTable fellowships={(data ?? []) as Row[]} view={safeView} search={search} page={pagination.page} pageSize={pagination.pageSize} totalCount={total} totalPages={pages} sort={safeSort} />
  </>;
}
