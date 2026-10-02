"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent, AppCardDescription, AppCardHeader, AppCardTitle } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetricBadge } from "@/components/ui/metric-badge";
import { LifecycleBadge } from "@/components/lifecycle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseBrowserClient } from "@/lib/supabase/client";

type AdvisorRecord = { advisor_id: number; advisor_name: string; email: string | null; role: string; is_active: boolean };
type Role = "Admin" | "Advisor";

export default function AdvisorManagementPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [advisors, setAdvisors] = useState<AdvisorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | "create" | null>(null);
  const [form, setForm] = useState({ email: "", displayName: "", role: "Advisor" as Role });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/advisors");
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? (response.status === 403 ? "Administrator access is required." : response.status === 401 ? "Your session has expired. Please sign in again." : "Unable to load advisors."));
      setAdvisors(Array.isArray(payload) ? payload : payload?.advisors ?? []);
    } catch (error) {
      toast.error("Advisor list unavailable", { description: error instanceof Error ? error.message : "Please try again." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let alive = true;
    supabaseBrowserClient.auth.getSession().then(({ data }) => {
      const admin = data.session?.user.app_metadata?.ocf_admin === true;
      if (!alive) return;
      setIsAdmin(admin);
      if (admin) void load(); else setLoading(false);
    });
    return () => { alive = false; };
  }, [load]);

  async function createAdvisor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("create");
    try {
      const response = await fetch("/api/advisors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? (response.status === 403 ? "Administrator access is required." : response.status === 401 ? "Your session has expired. Please sign in again." : "Unable to provision advisor."));
      toast.success("Advisor provisioned", { description: "The advisor account is ready." });
      setForm({ email: "", displayName: "", role: "Advisor" }); await load();
    } catch (error) { toast.error("Provisioning failed", { description: error instanceof Error ? error.message : "Please try again." }); }
    finally { setBusy(null); }
  }

  async function updateAdvisor(id: number, update: { role?: Role; isActive?: boolean }) {
    setBusy(id);
    try {
      const response = await fetch(`/api/advisors/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? (response.status === 403 ? "Administrator access is required." : response.status === 401 ? "Your session has expired. Please sign in again." : "Unable to update advisor."));
      toast.success("Advisor updated"); await load();
    } catch (error) { toast.error("Update failed", { description: error instanceof Error ? error.message : "Please try again." }); }
    finally { setBusy(null); }
  }

  if (!isAdmin) return <div className="mx-auto max-w-2xl py-16"><AppCard variant="soft"><AppCardContent className="flex items-start gap-4 p-6"><ShieldCheck className="mt-1 h-6 w-6 text-amber-600"/><div><h1 className="font-semibold text-slate-900">Administrator access required</h1><p className="mt-1 text-sm text-slate-600">Advisor management is available to OCF administrators only. Server authorization remains authoritative.</p></div></AppCardContent></AppCard></div>;

  return <div className="space-y-8">
    <PageHeader eyebrow="Access & accounts" title="Advisor Management" description="Provision advisor accounts and manage the roles and access status for your team."><MetricBadge tone="blue">{advisors.length} advisors</MetricBadge></PageHeader>
    <AppCard><AppCardHeader><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><UserPlus className="h-5 w-5"/></span><div><AppCardTitle>Provision an advisor</AppCardTitle><AppCardDescription>Create an advisor account with the appropriate workspace role.</AppCardDescription></div></div></AppCardHeader><AppCardContent><form onSubmit={createAdvisor} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_12rem_auto] xl:items-end">
      <div className="space-y-1.5"><Label htmlFor="displayName">Display name</Label><Input id="displayName" required value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})} placeholder="Jordan Lee"/></div>
      <div className="space-y-1.5"><Label htmlFor="advisorEmail">Email address</Label><Input id="advisorEmail" type="email" required value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="jordan@fgcu.edu"/></div>
      <div className="space-y-1.5"><Label>Role</Label><Select value={form.role} onValueChange={(role: Role)=>setForm({...form,role})}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="Advisor">Advisor</SelectItem><SelectItem value="Admin">Admin</SelectItem></SelectContent></Select></div>
      <Button type="submit" disabled={busy!==null}><UserPlus className="h-4 w-4"/>{busy==="create"?"Provisioning…":"Create advisor"}</Button>
    </form></AppCardContent></AppCard>
    <section className="space-y-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Users className="h-5 w-5 text-emerald-700"/>Advisor accounts</h2><p className="mt-1 text-sm text-slate-500">Role and status changes take effect according to server policy.</p></div><MetricBadge tone="slate">{advisors.filter(a=>a.is_active).length} active</MetricBadge></div>
      {loading ? <div className="rounded-2xl border border-border bg-white p-8 text-center text-sm text-slate-500">Loading advisor accounts…</div> : advisors.length===0 ? <AppCard variant="soft"><AppCardContent className="py-10 text-center"><Users className="mx-auto h-8 w-8 text-slate-400"/><p className="mt-3 font-medium text-slate-800">No advisor accounts yet</p><p className="mt-1 text-sm text-slate-500">Provision an advisor above to get started.</p></AppCardContent></AppCard> : <div className="grid gap-4 lg:grid-cols-2">{advisors.map(advisor=><AppCard key={advisor.advisor_id} variant="elevated"><AppCardContent className="p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h3 className="truncate font-semibold text-slate-900">{advisor.advisor_name}</h3><p className="mt-1 truncate text-sm text-slate-500">{advisor.email ?? "No email on file"}</p></div><LifecycleBadge kind="advisor" isActive={advisor.is_active} /></div><div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-border/70 pt-4"><div className="space-y-1.5"><Label htmlFor={`role-${advisor.advisor_id}`}>Role</Label><Select value={advisor.role} onValueChange={(role: Role)=>void updateAdvisor(advisor.advisor_id,{role})} disabled={busy===advisor.advisor_id}><SelectTrigger id={`role-${advisor.advisor_id}`} className="w-36"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="Advisor">Advisor</SelectItem><SelectItem value="Admin">Admin</SelectItem></SelectContent></Select></div><Button variant="outline" disabled={busy===advisor.advisor_id} onClick={()=>void updateAdvisor(advisor.advisor_id,{isActive:!advisor.is_active})}>{busy===advisor.advisor_id?"Saving…":advisor.is_active?"Deactivate":"Activate"}</Button></div></AppCardContent></AppCard>)}</div>}
    </section>
  </div>;
}
