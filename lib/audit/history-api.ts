/**
 * Client-safe audit-history transport contract.
 *
 * The browser NEVER reads `audit_activity` directly (that would ship the raw
 * `old_values`/`new_values`/`changes` payload columns into the client bundle
 * and rely on client-side normalization for privacy). Instead, older pages are
 * loaded from the server-only `GET /api/audit/history` endpoint, which projects
 * and normalizes each row server-side and returns only safe `AuditActivity`
 * fields. This module holds the shared request/response shapes and the pure
 * cursor/query (de)serializers used by BOTH the browser component and the
 * route handler, without importing any server-only module.
 */
import type { AuditActivity } from "@/lib/audit/presentation";

/**
 * Serializable descriptor of a bounded, server-paginated history query. It lets
 * a client "Load more" request the next page using exactly the same filters and
 * deterministic ordering as the initial server read.
 */
export type EntityHistoryQuery =
  | { kind: "entity"; entityType: string; entityId: number }
  | { kind: "application"; applicationIds: number[] }
  | { kind: "student"; studentId: number };

/**
 * Stable keyset position in the `occurred_at DESC, audit_id DESC` order.
 *
 * Continuation is "strictly older than this position", so events inserted
 * after the first page (which sort at/above the cursor) can never be re-served
 * or shift an offset — eliminating the duplicate/skip failure mode of
 * offset-based "load more".
 */
export interface AuditHistoryCursor {
  occurredAt: string;
  auditId: number;
}

/** One bounded, already-safe page returned by the history endpoint. */
export interface AuditHistoryPage {
  /** Normalized rows for this bounded page, newest-first. */
  items: AuditActivity[];
  /** True when at least one older row exists beyond this page. */
  hasMore: boolean;
  /** Cursor to request the next page, or null when this is the last page. */
  nextCursor: AuditHistoryCursor | null;
  /**
   * Snapshot high-watermark (the newest position of the first page). Every
   * continuation is pinned to this upper bound so a session never interleaves
   * newly recorded events mid-scroll.
   */
  highWatermark: AuditHistoryCursor | null;
}

/** Server-only, authenticated paginated safe-audit endpoint. */
export const AUDIT_HISTORY_ENDPOINT = "/api/audit/history";

/** Bound on how many application ids a single history query may target. */
export const MAX_HISTORY_APPLICATION_IDS = 100;

/** Entity types are lowercase snake_case identifiers. */
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Strict ISO-8601 timestamp shape. Only characters that can appear in a
 * Postgres `timestamptz` serialization are accepted, so a decoded cursor can
 * never smuggle PostgREST filter delimiters (`"`, `,`, `(`, `)`) into an
 * `.or(...)` expression.
 */
const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Encode a cursor as a single opaque token: `<auditId>.<occurredAt>`.
 * Returns null for an absent or malformed cursor. The timestamp is preserved
 * verbatim (no precision-losing re-serialization) so the keyset tie-break stays
 * exact against microsecond-precision `timestamptz` values.
 */
export function encodeAuditCursor(cursor?: AuditHistoryCursor | null): string | null {
  if (!cursor) return null;
  if (!isPositiveSafeInteger(cursor.auditId)) return null;
  if (typeof cursor.occurredAt !== "string") return null;
  if (!CURSOR_TIMESTAMP_PATTERN.test(cursor.occurredAt)) return null;
  return `${cursor.auditId}.${cursor.occurredAt}`;
}

/** Decode a cursor token, returning null for anything malformed or unsafe. */
export function decodeAuditCursor(token?: string | null): AuditHistoryCursor | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const auditId = Number(token.slice(0, separator));
  const occurredAt = token.slice(separator + 1);
  if (!isPositiveSafeInteger(auditId)) return null;
  if (!CURSOR_TIMESTAMP_PATTERN.test(occurredAt)) return null;
  return { occurredAt, auditId };
}

/** Build the query string for a history descriptor (filters only, no paging). */
export function serializeEntityHistoryQuery(query: EntityHistoryQuery): URLSearchParams {
  const params = new URLSearchParams();
  switch (query.kind) {
    case "entity":
      params.set("kind", "entity");
      params.set("entityType", query.entityType);
      params.set("entityId", String(query.entityId));
      break;
    case "student":
      params.set("kind", "student");
      params.set("studentId", String(query.studentId));
      break;
    case "application":
      params.set("kind", "application");
      params.set("applicationIds", query.applicationIds.join(","));
      break;
  }
  return params;
}

/**
 * Parse and validate an untrusted history descriptor. Returns null when the
 * request is not a well-formed, bounded descriptor (the route answers 400).
 */
export function parseEntityHistoryQuery(
  params: URLSearchParams
): EntityHistoryQuery | null {
  const kind = params.get("kind");
  if (kind === "entity") {
    const entityType = params.get("entityType");
    const entityId = Number(params.get("entityId"));
    if (!entityType || !ENTITY_TYPE_PATTERN.test(entityType)) return null;
    if (!isPositiveSafeInteger(entityId)) return null;
    return { kind: "entity", entityType, entityId };
  }
  if (kind === "student") {
    const studentId = Number(params.get("studentId"));
    if (!isPositiveSafeInteger(studentId)) return null;
    return { kind: "student", studentId };
  }
  if (kind === "application") {
    const raw = params.get("applicationIds");
    if (!raw) return null;
    const ids = Array.from(
      new Set(
        raw
          .split(",")
          .map((value) => Number(value.trim()))
          .filter(isPositiveSafeInteger)
      )
    );
    if (ids.length === 0 || ids.length > MAX_HISTORY_APPLICATION_IDS) return null;
    return { kind: "application", applicationIds: ids };
  }
  return null;
}
