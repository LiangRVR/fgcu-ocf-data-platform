"use client";

import { useState } from "react";
import { Clock3, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  auditActionLabel,
  formatAuditDate,
  visibleAuditItems,
  type AuditActivity,
} from "@/lib/audit/presentation";
import {
  AUDIT_HISTORY_ENDPOINT,
  encodeAuditCursor,
  serializeEntityHistoryQuery,
  type AuditHistoryCursor,
  type AuditHistoryPage,
  type EntityHistoryQuery,
} from "@/lib/audit/history-api";

export type { EntityHistoryQuery };

/**
 * Mirrors `ENTITY_HISTORY_PAGE_SIZE` in `@/lib/audit/read` without importing
 * the server-only module into the browser bundle.
 */
const DEFAULT_HISTORY_PAGE_SIZE = 25;

interface AuditHistoryProps {
  items: AuditActivity[];
  title?: string;
  /**
   * When provided, older pages load on demand through the bounded, server-only
   * safe history endpoint instead of the initial slice being the whole
   * timeline. Omitted for fully server-rendered, already-bounded lists (e.g.
   * the Activity page).
   */
  query?: EntityHistoryQuery;
  /** Whether the initial server page reported older rows beyond `items`. */
  hasMore?: boolean;
  /** Bounded page size for load-more; must match the server's page size. */
  pageSize?: number;
  /** Keyset cursor of the initial server page's last item. */
  nextCursor?: AuditHistoryCursor | null;
  /** Snapshot high-watermark captured by the initial server page. */
  highWatermark?: AuditHistoryCursor | null;
}

function HistoryList({ items }: { items: AuditActivity[] }) {
  const visible = visibleAuditItems(items);
  return visible.length ? (
    <ol className="space-y-3">
      {visible.map((item) => (
        <li key={item.id} className="grid gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-4 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{auditActionLabel(item.action)} <span className="font-normal">{item.entityLabel}</span></p>
            {item.summary ? <p className="mt-1 text-sm leading-5 text-slate-600">{item.summary}</p> : null}
            {item.changes?.length ? <dl className="mt-3 grid gap-2 sm:grid-cols-2">{item.changes.map((change) => <div key={change.field} className="min-w-0 rounded-lg border border-white bg-white/80 px-3 py-2"><dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{change.label}</dt><dd className="mt-1 break-words text-sm text-slate-800"><span className="text-slate-500">{change.oldValue}</span><span aria-hidden="true" className="mx-2 text-emerald-700">→</span><span className="font-medium">{change.newValue}</span><span className="sr-only"> changed to </span></dd></div>)}</dl> : null}
            <p className="mt-2 text-xs text-slate-500">{item.actor ? `By ${item.actor}` : "Recorded change"}</p></div>
          <time className="flex items-start gap-1.5 text-right text-xs text-slate-500"><Clock3 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{formatAuditDate(item.occurredAt)}</time>
        </li>
      ))}
    </ol>
  ) : <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No change history is available yet.</p>;
}

function LoadableHistory({ items, query, hasMore, pageSize, nextCursor, highWatermark }: {
  items: AuditActivity[];
  query: EntityHistoryQuery;
  hasMore?: boolean;
  pageSize?: number;
  nextCursor?: AuditHistoryCursor | null;
  highWatermark?: AuditHistoryCursor | null;
}) {
  const [entries, setEntries] = useState(items);
  const [more, setMore] = useState(Boolean(hasMore));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<AuditHistoryCursor | null>(nextCursor ?? null);
  const [watermark, setWatermark] = useState<AuditHistoryCursor | null>(highWatermark ?? null);
  const limit = pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;

  async function loadMore() {
    // Continuation MUST carry a keyset cursor; without one a retry could
    // re-serve the newest page and duplicate rows.
    const cursorToken = encodeAuditCursor(cursor);
    if (!cursorToken) {
      setMore(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      // A single bounded, safe, keyset-paginated request per page — never a
      // raw client-side `audit_activity` read and never a per-row lookup.
      const params = serializeEntityHistoryQuery(query);
      params.set("limit", String(limit));
      params.set("cursor", cursorToken);
      const watermarkToken = encodeAuditCursor(watermark);
      if (watermarkToken) params.set("watermark", watermarkToken);

      const response = await fetch(`${AUDIT_HISTORY_ENDPOINT}?${params.toString()}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const page = (await response.json()) as AuditHistoryPage;
      setEntries((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
      setWatermark((current) => current ?? page.highWatermark);
      setMore(page.hasMore);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <HistoryList items={entries} />
      {failed ? <p role="alert" className="mt-3 text-center text-sm text-red-600">Could not load more history. Please try again.</p> : null}
      {more ? (
        <div className="mt-4 flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function AuditHistory({ items, title = "Change history", query, hasMore, pageSize, nextCursor, highWatermark }: AuditHistoryProps) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border/70 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-[#006747]"><History aria-hidden="true" className="h-5 w-5" /></span>
        <div><h2 className="font-semibold text-slate-900">{title}</h2><p className="text-sm text-slate-500">A readable record of changes to this entry.</p></div>
      </div>
      {query
        ? <LoadableHistory items={items} query={query} hasMore={hasMore} pageSize={pageSize} nextCursor={nextCursor} highWatermark={highWatermark} />
        : <HistoryList items={items} />}
    </section>
  );
}

export function EntityHistory({ items, title, query, hasMore, pageSize, nextCursor, highWatermark }: AuditHistoryProps) {
  return <AuditHistory items={items} title={title} query={query} hasMore={hasMore} pageSize={pageSize} nextCursor={nextCursor} highWatermark={highWatermark} />;
}
