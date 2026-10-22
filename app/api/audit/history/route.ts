/**
 * app/api/audit/history/route.ts
 *
 * Server-only, authenticated, paginated SAFE audit-history endpoint:
 *
 *   GET /api/audit/history?kind=...&<descriptor>&limit=&cursor=&watermark=
 *
 * The browser never reads `audit_activity` directly, and the projection itself
 * no longer carries raw audit JSON. This handler reads the explicit safe
 * projection, normalizes each row through `normalizeAuditRow` (attaching the
 * server-only raw diff read in ONE bounded batch from the `audit_event` base
 * table through the server-only service-role client), and returns only safe
 * `AuditActivity` fields — raw snapshot payload columns (`old_values`/
 * `new_values`) and the raw diff (`changes`) are unreadable by every client role
 * (migration `20261023000001`), so they can never reach the response. Pagination
 * is keyset/high-watermark based (see `@/lib/audit/read`), so a "load more" that
 * races a new insert can neither duplicate nor skip an event. Every page is a
 * bounded safe-view query plus one bounded raw-diff batch (no N+1).
 *
 * Authorization: any authenticated session. The underlying `audit_activity`
 * view remains governed by its own SECURITY INVOKER RLS, so this handler adds
 * an explicit session gate without widening read access.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import {
  getApplicationHistoryPage,
  getEntityHistoryPage,
  getStudentActivityPage,
} from "@/lib/audit/read";
import {
  decodeAuditCursor,
  parseEntityHistoryQuery,
  type AuditHistoryPage,
} from "@/lib/audit/history-api";

export async function GET(request: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const query = parseEntityHistoryQuery(params);
  if (!query) {
    return NextResponse.json({ error: "Invalid history query." }, { status: 400 });
  }

  const cursorToken = params.get("cursor");
  const watermarkToken = params.get("watermark");
  const cursor = cursorToken ? decodeAuditCursor(cursorToken) : null;
  const highWatermark = watermarkToken ? decodeAuditCursor(watermarkToken) : null;
  if ((cursorToken && !cursor) || (watermarkToken && !highWatermark)) {
    return NextResponse.json({ error: "Invalid history cursor." }, { status: 400 });
  }

  const limitParam = params.get("limit");
  const options = {
    limit: limitParam === null ? undefined : Number(limitParam),
    cursor,
    highWatermark,
  };

  try {
    const page =
      query.kind === "entity"
        ? await getEntityHistoryPage(query.entityType, query.entityId, options)
        : query.kind === "student"
          ? await getStudentActivityPage(query.studentId, options)
          : await getApplicationHistoryPage(query.applicationIds, options);

    const body: AuditHistoryPage = page;
    return NextResponse.json(body);
  } catch {
    console.error("[api:audit] Failed to read audit history.");
    return NextResponse.json({ error: "Failed to read history." }, { status: 500 });
  }
}
