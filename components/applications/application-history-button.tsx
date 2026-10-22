"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EntityHistory } from "@/components/history/audit-history";
import type { AuditActivity } from "@/lib/audit/presentation";
import {
  AUDIT_HISTORY_ENDPOINT,
  serializeEntityHistoryQuery,
  type AuditHistoryCursor,
  type AuditHistoryPage,
} from "@/lib/audit/history-api";

/** Mirrors ENTITY_HISTORY_PAGE_SIZE in @/lib/audit/read (server-only). */
const PAGE_SIZE = 25;

export function ApplicationHistoryButton({ applicationId }: { applicationId: number }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AuditActivity[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<AuditHistoryCursor | null>(null);
  const [highWatermark, setHighWatermark] = useState<AuditHistoryCursor | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function showHistory() {
    setOpen(true);
    if (loaded) return;
    setLoading(true);
    try {
      // Bounded first page only, through the server-only SAFE endpoint (no raw
      // `audit_activity select('*')` in the browser); older events load on
      // demand via the keyset `Load more` path in EntityHistory.
      const params = serializeEntityHistoryQuery({ kind: "application", applicationIds: [applicationId] });
      params.set("limit", String(PAGE_SIZE));
      const response = await fetch(`${AUDIT_HISTORY_ENDPOINT}?${params.toString()}`, {
        headers: { accept: "application/json" },
      });
      if (response.ok) {
        const page = (await response.json()) as AuditHistoryPage;
        setItems(page.items);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        setHighWatermark(page.highWatermark);
        setLoaded(true);
      }
    } finally { setLoading(false); }
  }

  return <>
    <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 text-slate-600" onClick={showHistory} aria-label="View application history">
      <History aria-hidden="true" className="h-4 w-4" /><span>View history</span>
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Application history</DialogTitle><DialogDescription>Recorded changes for this application. Sensitive values are not shown.</DialogDescription></DialogHeader>
        {loading ? <p role="status" className="py-8 text-center text-sm text-slate-500">Loading history…</p> : <EntityHistory items={items} hasMore={hasMore} nextCursor={nextCursor} highWatermark={highWatermark} pageSize={PAGE_SIZE} query={{ kind: "application", applicationIds: [applicationId] }} title="Changes" />}
      </DialogContent>
    </Dialog>
  </>;
}
