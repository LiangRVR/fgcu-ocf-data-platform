import { createServerClient } from "@/lib/supabase/server";
import { normalizeAuditRow, type AuditActivity, type AuditRow } from "@/lib/audit/presentation";
import type { AuditHistoryCursor } from "@/lib/audit/history-api";

/**
 * Entity/subject history reads are bounded, server paginated, and safe.
 *
 * Every history read requests at most `ENTITY_HISTORY_PAGE_SIZE` rows from the
 * database in a single query (newest-first, `audit_id` tie-broken) and never
 * performs per-row or related-entity lookups — so a detail page or a load-more
 * click can neither pull unbounded history nor fan out into an N+1 query
 * pattern. Rows are projected to the explicit safe columns and normalized
 * through `normalizeAuditRow`, so raw `old_values`/`new_values` snapshot
 * payloads never leave the server.
 *
 * Pagination is KEYSET (cursor) based, not offset based: continuation asks for
 * rows strictly older than the last returned `(occurred_at, audit_id)` and is
 * optionally pinned to the first page's high-watermark. Newly recorded events
 * therefore never shift a page boundary — no duplicate or skipped rows.
 */
export const ENTITY_HISTORY_PAGE_SIZE = 25;

/** Hard ceiling for an explicit `limit`, independent of the caller. */
export const MAX_ENTITY_HISTORY_PAGE_SIZE = 100;

/**
 * Explicit safe projection for the activity view. Only the columns the safe
 * normalizer needs are fetched; the raw snapshot payloads (`old_values`,
 * `new_values`) and Auth-binding/provenance ids are deliberately excluded.
 */
export const AUDIT_ACTIVITY_SAFE_COLUMNS =
  "audit_id, occurred_at, entity_type, action, actor_name_snapshot, reason, changes, student_name, fellowship_name";

export interface EntityHistoryPageOptions {
  /**
   * Rows per page. Clamped to `1..MAX_ENTITY_HISTORY_PAGE_SIZE`; missing,
   * non-finite, or non-positive values fall back to `ENTITY_HISTORY_PAGE_SIZE`.
   */
  limit?: number;
  /**
   * Keyset cursor: return only rows strictly older than this position. Null
   * (the first page) starts from the newest row.
   */
  cursor?: AuditHistoryCursor | null;
  /**
   * Optional snapshot high-watermark: never return rows newer than this
   * position, so a session's pages stay pinned to the first page's snapshot.
   */
  highWatermark?: AuditHistoryCursor | null;
}

export interface EntityHistoryPage {
  /** Normalized rows for this bounded page, newest-first. */
  items: AuditActivity[];
  /** True when at least one older row exists beyond this page. */
  hasMore: boolean;
  /** Cursor to request the next page, or null when this is the last page. */
  nextCursor: AuditHistoryCursor | null;
  /** Snapshot high-watermark for this page (null when no rows were returned). */
  highWatermark: AuditHistoryCursor | null;
}

/** Normalize caller-supplied page size into a safe, bounded window. */
function resolveLimit(options?: EntityHistoryPageOptions): number {
  const requestedLimit = options?.limit;
  return typeof requestedLimit === "number" &&
    Number.isFinite(requestedLimit) &&
    requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MAX_ENTITY_HISTORY_PAGE_SIZE)
    : ENTITY_HISTORY_PAGE_SIZE;
}

function cursorOf(row: AuditRow): AuditHistoryCursor {
  return { occurredAt: row.occurred_at, auditId: row.audit_id };
}

/**
 * Build a page result from the raw rows returned by a `limit + 1` probe query.
 * The extra probe row only signals `hasMore`; it is never surfaced.
 */
function toPage(
  rows: AuditRow[],
  limit: number,
  providedWatermark: AuditHistoryCursor | null
): EntityHistoryPage {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(normalizeAuditRow),
    hasMore,
    nextCursor: hasMore && last ? cursorOf(last) : null,
    highWatermark: providedWatermark ?? (first ? cursorOf(first) : null),
  };
}

const EMPTY_PAGE: EntityHistoryPage = {
  items: [],
  hasMore: false,
  nextCursor: null,
  highWatermark: null,
};

/** PostgREST `or` fragment for "strictly older than this keyset position". */
function strictlyOlderThan(cursor: AuditHistoryCursor): string {
  const ts = `"${cursor.occurredAt}"`;
  return `occurred_at.lt.${ts},and(occurred_at.eq.${ts},audit_id.lt.${cursor.auditId})`;
}

/** PostgREST `or` fragment for "not newer than this keyset position". */
function notNewerThan(cursor: AuditHistoryCursor): string {
  const ts = `"${cursor.occurredAt}"`;
  return `occurred_at.lt.${ts},and(occurred_at.eq.${ts},audit_id.lte.${cursor.auditId})`;
}

/**
 * Apply the cursor / high-watermark bounds to a filter builder. Both bounds are
 * additional AND conditions (PostgREST ANDs repeated `or` params); the
 * strictly-older cursor is what makes continuation duplicate/skip free.
 */
function applyWindow<T extends { or(filter: string): T }>(
  request: T,
  options?: EntityHistoryPageOptions
): T {
  let next = request;
  if (options?.highWatermark) next = next.or(notNewerThan(options.highWatermark));
  if (options?.cursor) next = next.or(strictlyOlderThan(options.cursor));
  return next;
}

/**
 * One bounded, newest-first page of history for a specific entity row
 * (`entity_type` + `entity_id`), e.g. a single advisor or fellowship.
 */
export async function getEntityHistoryPage(
  entityType: string,
  entityId: number,
  options?: EntityHistoryPageOptions
): Promise<EntityHistoryPage> {
  const limit = resolveLimit(options);
  const supabase = createServerClient();
  const request = applyWindow(
    supabase
      .from("audit_activity")
      .select(AUDIT_ACTIVITY_SAFE_COLUMNS)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []) as unknown as AuditRow[], limit, options?.highWatermark ?? null);
}

/**
 * One bounded, newest-first page of history for a student's unified subject
 * timeline (`student_subject_ids`): every event about the student from any
 * entity context, including immutable prior associations after a re-link, in a
 * single bounded query.
 */
export async function getStudentActivityPage(
  studentId: number,
  options?: EntityHistoryPageOptions
): Promise<EntityHistoryPage> {
  const limit = resolveLimit(options);
  const supabase = createServerClient();
  const request = applyWindow(
    supabase
       .from("audit_activity")
       .select(AUDIT_ACTIVITY_SAFE_COLUMNS)
       .contains("student_subject_ids", [studentId]),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []) as unknown as AuditRow[], limit, options?.highWatermark ?? null);
}

/**
 * One bounded, newest-first page of history for a set of applications, in a
 * single `IN` query (no per-application fan-out).
 */
export async function getApplicationHistoryPage(
  applicationIds: number[],
  options?: EntityHistoryPageOptions
): Promise<EntityHistoryPage> {
  if (!applicationIds.length) return EMPTY_PAGE;
  const limit = resolveLimit(options);
  const supabase = createServerClient();
  const request = applyWindow(
    supabase
      .from("audit_activity")
      .select(AUDIT_ACTIVITY_SAFE_COLUMNS)
      .in("subject_application_id", applicationIds),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []) as unknown as AuditRow[], limit, options?.highWatermark ?? null);
}

/**
 * Bounded convenience view of {@link getEntityHistoryPage}: only the first
 * page of history is ever loaded, instead of the full unbounded timeline.
 */
export async function getEntityHistory(
  entityType: string,
  entityId: number,
  options?: EntityHistoryPageOptions
): Promise<AuditActivity[]> {
  return (await getEntityHistoryPage(entityType, entityId, options)).items;
}

/** Bounded convenience view of {@link getApplicationHistoryPage}. */
export async function getApplicationHistory(
  applicationIds: number[],
  options?: EntityHistoryPageOptions
): Promise<AuditActivity[]> {
  return (await getApplicationHistoryPage(applicationIds, options)).items;
}

/** Bounded convenience view of {@link getStudentActivityPage}. */
export async function getStudentActivity(
  studentId: number,
  options?: EntityHistoryPageOptions
): Promise<AuditActivity[]> {
  return (await getStudentActivityPage(studentId, options)).items;
}
