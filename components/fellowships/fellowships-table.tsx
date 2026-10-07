"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Award, Eye, Search } from "lucide-react";
import type { Database } from "@/types/database";
import { AppCard, AppCardContent } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { DataToolbar } from "@/components/ui/data-toolbar";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/pagination/pagination";
import { LifecycleAction } from "@/components/lifecycle";
import { FellowshipEditButton } from "@/components/fellowships/fellowship-edit-button";
import { AddFellowshipButton } from "@/components/fellowships/add-fellowship-button";
import { updateListSearchParams, type PageSize } from "@/lib/utils/pagination";

type Row = Database["public"]["Views"]["fellowship_list"]["Row"];
interface Props { fellowships: Row[]; view: string; search: string; page: number; pageSize: PageSize; totalCount: number; totalPages: number; sort: string }

export function FellowshipsTable({ fellowships, view, search, page, pageSize, totalCount, totalPages, sort }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(search);
  const archived = view === "archived";
  const href = (patch: {page?:number;pageSize?:number;search?:string;sort?:string}) => {
    const next = updateListSearchParams(params.toString(), patch);
    const text = next.toString(); return `/fellowships${text ? `?${text}` : ""}`;
  };
  const actions = (row: Row) => <div className="flex items-center justify-end gap-1">
    <Link href={`/fellowships/${row.fellowship_id}`} prefetch={false}><Button variant="ghost" size="icon" title="View fellowship" aria-label="View fellowship"><Eye className="h-4 w-4" /></Button></Link>
    <FellowshipEditButton fellowshipId={row.fellowship_id} fellowshipName={row.fellowship_name} />
    <LifecycleAction entity="fellowship" entityId={row.fellowship_id} entityLabel={row.fellowship_name} action={archived ? "restore" : "archive"} variant="ghost" iconOnly className="text-amber-700" />
  </div>;
  return <>
    <DataToolbar className="mb-4" leading={<div className="relative w-full sm:max-w-xs"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input className="pl-9" placeholder="Search fellowships..." value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key === "Enter" && router.push(href({search:query}))} /></div>} trailing={<div className="flex items-center gap-2"><label className="sr-only" htmlFor="fellowship-sort">Sort fellowships</label><select id="fellowship-sort" className="h-9 rounded-md border bg-white px-2 text-sm" value={sort} onChange={e=>router.push(href({sort:e.target.value}))}><option value="fellowship_name">Name</option><option value="fellowship_id">ID</option></select><Button variant="outline" size="sm" onClick={()=>router.push(href({search:query}))}>Search</Button></div>} />
    <AppCard><AppCardContent className="p-0">{fellowships.length === 0 ? <EmptyState icon={Award} title={search ? "No fellowships match your search" : view === "no-applicants" ? "All fellowships have applicants" : archived ? "No archived fellowships" : "No fellowships found"} description={search ? "Try a different search term." : "Fellowships will appear here when available."} action={!search && view === "all" ? <AddFellowshipButton size="default" /> : undefined} /> : <>
      <div className="divide-y md:hidden">{fellowships.map(row => <article key={row.fellowship_id} className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3"><Link href={`/fellowships/${row.fellowship_id}`} prefetch={false} className="font-medium text-slate-900 hover:text-[#006747] hover:underline">{row.fellowship_name}</Link>{actions(row)}</div>
        <dl className="grid grid-cols-3 gap-2 text-sm"><div><dt className="text-xs text-slate-500">Applications</dt><dd className="mt-1 tabular-nums">{row.total_applications}</dd></div><div><dt className="text-xs text-slate-500">Finalists</dt><dd className="mt-1 tabular-nums">{row.finalists}</dd></div><div><dt className="text-xs text-slate-500">Awarded</dt><dd className="mt-1 tabular-nums">{row.awarded_students}</dd></div></dl>
      </article>)}</div>
      <div className="hidden overflow-x-auto md:block"><table className="w-full"><thead className="bg-gray-50"><tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500"><th className="px-4 py-3 sm:px-6">Fellowship</th><th className="px-4 py-3 text-right">Applications</th><th className="hidden px-4 py-3 text-right md:table-cell">Finalists</th><th className="hidden px-4 py-3 text-right md:table-cell">Awarded</th><th className="px-4 py-3 text-right">Actions</th></tr></thead><tbody className="divide-y">{fellowships.map(row=><tr key={row.fellowship_id} className="hover:bg-slate-50"><td className="px-4 py-4 sm:px-6"><Link href={`/fellowships/${row.fellowship_id}`} prefetch={false} className="font-medium text-slate-900 hover:text-[#006747] hover:underline">{row.fellowship_name}</Link></td><td className="px-4 py-4 text-right tabular-nums">{row.total_applications}</td><td className="hidden px-4 py-4 text-right tabular-nums md:table-cell">{row.finalists}</td><td className="hidden px-4 py-4 text-right tabular-nums md:table-cell">{row.awarded_students}</td><td className="px-4 py-4">{actions(row)}</td></tr>)}</tbody></table></div>
    </>}</AppCardContent></AppCard>
    <Pagination page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} getPageHref={n=>href({page:n})} getPageSizeHref={n=>href({pageSize:n})} />
  </>;
}
