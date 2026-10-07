"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RotateCw, Search, ShieldCheck, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { AppCard, AppCardContent, AppCardDescription, AppCardHeader, AppCardTitle } from "@/components/ui/app-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetricBadge } from "@/components/ui/metric-badge";
import { LifecycleBadge } from "@/components/lifecycle";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination } from "@/components/pagination";
import { supabaseBrowserClient } from "@/lib/supabase/client";
import {
  applyAdvisorQueryPatch,
  canonicalAdvisorSearchParams,
  parseAdvisorListQuery,
  toAdvisorSearchParams,
  type AdvisorListRow,
  type AdvisorQueryPatch,
  type AdvisorRoleValue,
} from "./query";

type Role = AdvisorRoleValue;
type Busy = number | "create" | null;

type AdvisorListMeta = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

const EMPTY_META: AdvisorListMeta = { page: 1, pageSize: 25, totalCount: 0, totalPages: 0 };

function advisorErrorMessage(status: number, serverMessage?: string): string {
  if (status === 403) return "Administrator access is required.";
  if (status === 401) return "Your session has expired. Please sign in again.";
  return serverMessage || "Unable to load advisors.";
}

/**
 * Presentational, page-local list surface. Kept free of data/URL concerns so
 * the loading, failure, zero-row, and paginated states can be rendered in
 * isolation by the page unit test.
 */
export function AdvisorAccountsPanel({
  advisors,
  meta,
  loading,
  error,
  busy,
  query,
  onPageChange,
  onPageSizeChange,
  onRetry,
  onRoleChange,
  onToggleActive,
}: {
  advisors: AdvisorListRow[];
  meta: AdvisorListMeta;
  loading: boolean;
  error: string | null;
  busy: Busy;
  query: { role: Role | null; active: boolean | null };
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRetry: () => void;
  onRoleChange: (id: number, role: Role) => void;
  onToggleActive: (id: number, isActive: boolean) => void;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <Users className="h-5 w-5 text-emerald-700" />
            Advisor accounts
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Role and status changes take effect according to server policy.
          </p>
        </div>
        <MetricBadge tone="slate">
          {meta.totalCount} {meta.totalCount === 1 ? "advisor" : "advisors"}
        </MetricBadge>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-border bg-white p-8 text-center text-sm text-slate-500">
          Loading advisor accounts…
        </div>
      ) : error ? (
        <AppCard variant="soft">
          <AppCardContent className="py-10 text-center">
            <ShieldCheck className="mx-auto h-8 w-8 text-amber-600" />
            <p className="mt-3 font-medium text-slate-800">Advisor list unavailable</p>
            <p className="mt-1 text-sm text-slate-500">{error}</p>
            <Button variant="outline" className="mt-4" onClick={onRetry}>
              <RotateCw className="h-4 w-4" />
              Try again
            </Button>
          </AppCardContent>
        </AppCard>
      ) : advisors.length === 0 ? (
        <AppCard variant="soft">
          <AppCardContent className="py-10 text-center">
            <Users className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 font-medium text-slate-800">
              {query.active !== null || query.role !== null ? "No matching advisors" : "No advisor accounts yet"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {query.active !== null || query.role !== null
                ? "Adjust or clear the filters to see more advisor accounts."
                : "Provision an advisor above to get started."}
            </p>
          </AppCardContent>
        </AppCard>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {advisors.map((advisor) => (
            <AppCard key={advisor.advisor_id} variant="elevated">
              <AppCardContent className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-slate-900">{advisor.advisor_name}</h3>
                    <p className="mt-1 truncate text-sm text-slate-500">{advisor.email ?? "No email on file"}</p>
                  </div>
                  <LifecycleBadge kind="advisor" isActive={advisor.is_active} />
                </div>
                <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-border/70 pt-4">
                  <div className="space-y-1.5">
                    <Label htmlFor={`role-${advisor.advisor_id}`}>Role</Label>
                    <Select
                      value={advisor.role}
                      onValueChange={(role: Role) => onRoleChange(advisor.advisor_id, role)}
                      disabled={busy === advisor.advisor_id}
                    >
                      <SelectTrigger id={`role-${advisor.advisor_id}`} className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Advisor">Advisor</SelectItem>
                        <SelectItem value="Admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    disabled={busy === advisor.advisor_id}
                    onClick={() => onToggleActive(advisor.advisor_id, !advisor.is_active)}
                  >
                    {busy === advisor.advisor_id ? "Saving…" : advisor.is_active ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </AppCardContent>
            </AppCard>
          ))}
        </div>
      )}

      {!loading && !error && meta.totalCount > 0 ? (
        <Pagination
          page={meta.page}
          pageSize={meta.pageSize}
          totalCount={meta.totalCount}
          totalPages={meta.totalPages}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      ) : null}
    </section>
  );
}

function AdvisorManagement() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const query = useMemo(() => parseAdvisorListQuery(searchParamsString), [searchParamsString]);

  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [advisors, setAdvisors] = useState<AdvisorListRow[]>([]);
  const [meta, setMeta] = useState<AdvisorListMeta>({
    ...EMPTY_META,
    pageSize: query.pageSize,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [searchInput, setSearchInput] = useState(query.search);
  const [form, setForm] = useState({ email: "", displayName: "", role: "Advisor" as Role });

  const navigate = useCallback(
    (patch: AdvisorQueryPatch) => {
      const next = applyAdvisorQueryPatch(searchParamsRef.current.toString(), patch);
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname]
  );

  const load = useCallback(async () => {
    if (isAdmin !== true) return;
    setLoading(true);
    setError(null);
    try {
      const params = toAdvisorSearchParams(query);
      const response = await fetch(`/api/advisors?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(advisorErrorMessage(response.status, payload?.error));
      }
      setAdvisors(Array.isArray(payload?.advisors) ? (payload.advisors as AdvisorListRow[]) : []);
      setMeta({
        page: typeof payload?.page === "number" ? payload.page : query.page,
        pageSize: typeof payload?.pageSize === "number" ? payload.pageSize : query.pageSize,
        totalCount: typeof payload?.totalCount === "number" ? payload.totalCount : 0,
        totalPages: typeof payload?.totalPages === "number" ? payload.totalPages : 0,
      });
    } catch (cause) {
      setAdvisors([]);
      setError(cause instanceof Error ? cause.message : "Unable to load advisors.");
    } finally {
      setLoading(false);
    }
  }, [isAdmin, query]);

  useEffect(() => {
    let alive = true;
    supabaseBrowserClient.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const admin = data.session?.user.app_metadata?.ocf_admin === true;
      setIsAdmin(admin);
      if (!admin) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (isAdmin === true) void load();
    else if (isAdmin === false) setLoading(false);
  }, [isAdmin, load]);

  // Keep the search box in sync with URL-driven navigation (Back/Forward).
  useEffect(() => {
    setSearchInput(query.search);
  }, [query.search]);

  // Debounce search into the URL; completed state lives in the URL.
  useEffect(() => {
    const nextSearch = searchInput.trim();
    if (nextSearch === query.search) return;
    const timer = setTimeout(() => {
      navigate({ search: nextSearch || null });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, query.search]);

  // Canonicalize malformed/out-of-range URL state once the server answers. A
  // zero-result set has no valid page beyond 1, so the URL replaces to page 1
  // without issuing a further replacement fetch.
  useEffect(() => {
    if (loading) return;
    const current = searchParamsRef.current.toString();
    const resolvedPage = meta.totalCount === 0 ? 1 : meta.page;
    const canonical = canonicalAdvisorSearchParams(current, { page: resolvedPage });
    if (canonical.toString() !== current) {
      const qs = canonical.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }
  }, [loading, meta.page, meta.totalCount, router, pathname]);

  async function createAdvisor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    try {
      const response = await fetch("/api/advisors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(advisorErrorMessage(response.status, payload?.error));
      toast.success("Advisor provisioned", { description: "The advisor account is ready." });
      setForm({ email: "", displayName: "", role: "Advisor" });
      await load();
    } catch (cause) {
      toast.error("Provisioning failed", {
        description: cause instanceof Error ? cause.message : "Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function updateAdvisor(id: number, update: { role?: Role; isActive?: boolean }) {
    setBusy(id);
    try {
      const response = await fetch(`/api/advisors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(advisorErrorMessage(response.status, payload?.error));
      toast.success("Advisor updated");
      await load();
    } catch (cause) {
      toast.error("Update failed", {
        description: cause instanceof Error ? cause.message : "Please try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <AppCard variant="soft">
          <AppCardContent className="flex items-start gap-4 p-6">
            <ShieldCheck className="mt-1 h-6 w-6 text-amber-600" />
            <div>
              <h1 className="font-semibold text-slate-900">Administrator access required</h1>
              <p className="mt-1 text-sm text-slate-600">
                Advisor management is available to OCF administrators only. Server authorization remains authoritative.
              </p>
            </div>
          </AppCardContent>
        </AppCard>
      </div>
    );
  }

  const activeValue = query.active === null ? "all" : query.active ? "active" : "inactive";

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Access & accounts"
        title="Advisor Management"
        description="Provision advisor accounts and manage the roles and access status for your team."
      >
        <MetricBadge tone="blue">{meta.totalCount} advisors</MetricBadge>
      </PageHeader>

      <AppCard>
        <AppCardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <UserPlus className="h-5 w-5" />
            </span>
            <div>
              <AppCardTitle>Provision an advisor</AppCardTitle>
              <AppCardDescription>
                Create an advisor account with the appropriate workspace role.
              </AppCardDescription>
            </div>
          </div>
        </AppCardHeader>
        <AppCardContent>
          <form
            onSubmit={createAdvisor}
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_12rem_auto] xl:items-end"
          >
            <div className="space-y-1.5">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                required
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                placeholder="Jordan Lee"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advisorEmail">Email address</Label>
              <Input
                id="advisorEmail"
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="jordan@fgcu.edu"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(role: Role) => setForm({ ...form, role })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Advisor">Advisor</SelectItem>
                  <SelectItem value="Admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={busy !== null}>
              <UserPlus className="h-4 w-4" />
              {busy === "create" ? "Provisioning…" : "Create advisor"}
            </Button>
          </form>
        </AppCardContent>
      </AppCard>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_12rem_12rem]">
        <div className="space-y-1.5">
          <Label htmlFor="advisor-search">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="advisor-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search name or email"
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select
            value={activeValue}
            onValueChange={(value) => navigate({ active: value === "all" ? null : value === "active" })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select
            value={query.role ?? "all"}
            onValueChange={(value) =>
              navigate({ role: value === "all" ? null : (value as Role) })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="Admin">Admin</SelectItem>
              <SelectItem value="Advisor">Advisor</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <AdvisorAccountsPanel
        advisors={advisors}
        meta={meta}
        loading={loading}
        error={error}
        busy={busy}
        query={{ role: query.role, active: query.active }}
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => navigate({ pageSize })}
        onRetry={() => void load()}
        onRoleChange={(id, role) => void updateAdvisor(id, { role })}
        onToggleActive={(id, isActive) => void updateAdvisor(id, { isActive })}
      />
    </div>
  );
}

export default function AdvisorManagementPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-2xl border border-border bg-white p-8 text-center text-sm text-slate-500">
          Loading advisor accounts…
        </div>
      }
    >
      <AdvisorManagement />
    </Suspense>
  );
}
