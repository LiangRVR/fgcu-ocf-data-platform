import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isAuditRow,
  normalizeAuditRow,
  type AuditActivity,
  type AuditActivityViewRow,
  type AuditRow,
} from "@/lib/audit/presentation";
import type { AuditHistoryCursor } from "@/lib/audit/history-api";

/**
 * Entity/subject history reads are bounded, server paginated, and safe.
 *
 * Every history read requests at most `ENTITY_HISTORY_PAGE_SIZE` rows from the
 * browser-safe `audit_activity` view (newest-first, `audit_id` tie-broken) and
 * never performs per-row or related-entity lookups. The only additional read is
 * ONE bounded batch over the `audit_event` base table (`changes` for exactly
 * this page's audit ids) so the typed diff can be built server-side without
 * exposing raw JSON on the projection — so a detail page or a load-more click
 * can neither pull unbounded history nor fan out into an N+1 query pattern.
 * Rows are projected to the explicit safe columns and normalized through
 * `normalizeAuditRow`, so raw `old_values`/`new_values` snapshot payloads never
 * leave the server.
 *
 * The raw diff is a DB-enforced server-only boundary: `authenticated` holds only
 * COLUMN-level SELECT on the non-raw `audit_event` columns (migration
 * `20261023000001_audit_event_raw_payload_boundary`), so no browser/RLS client
 * can read `changes` directly. The bounded raw-diff batch is therefore read with
 * the server-only service-role client (`createAdminClient`), and ONLY after the
 * cookie/RLS safe-view query above has already authorized and bounded the
 * page's audit ids.
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
 * Explicit safe projection for the browser-safe `audit_activity` view. Only the
 * columns the safe normalizer needs are fetched; the raw snapshot payloads
 * (`old_values`, `new_values`, `changes`) and Auth-binding/provenance ids are
 * deliberately excluded, so they never leave the database. The view itself no
 * longer exposes the raw JSON columns, so an authenticated browser client cannot
 * select raw audit JSON through the app's projection (see migration
 * `20261022000001`). The `audit_event` base table is also closed: `authenticated`
 * holds only column-level SELECT on the non-raw columns (migration
 * `20261023000001`), so raw `old_values`/`new_values`/`changes` are unreachable
 * by any client role. The server-only raw diff needed to build typed changes is
 * read through the service-role client and never reaches React.
 *
 * The relationship-aware scalars (`previous_*`/`current_*` student and
 * fellowship names AND endpoint ids, `subject_application_name`), the
 * per-field Fellowship Thursday predecessor/current scalars, the exact
 * `void_reason`, and the immutable advising parent scalars
 * (`advising_meeting_date`/`advising_application_id`/`advising_advisor_id`) are
 * safe pre-derived values resolved by the view, so a history read can present
 * event-time context without a live/mutable join.
 */
export const AUDIT_ACTIVITY_SAFE_COLUMNS =
  "audit_id, occurred_at, entity_type, action, actor_name_snapshot, reason, " +
  "student_name, fellowship_name, previous_student_name, current_student_name, " +
  "previous_fellowship_name, current_fellowship_name, subject_application_name, " +
  "previous_student_id, current_student_id, previous_fellowship_id, current_fellowship_id, " +
  "fellowship_thursday_attended_before, fellowship_thursday_attended_after, " +
  "fellowship_thursday_attended_amended, fellowship_thursday_source_before, " +
  "fellowship_thursday_source_after, fellowship_thursday_source_amended, void_reason, " +
  "advising_meeting_date, advising_application_id, advising_advisor_id";

/**
 * Explicit safe projection for the SERVER-ONLY raw-diff read. The raw
 * `changes` diff lives on the `audit_event` base table but is NOT reachable by
 * any client role: `authenticated` holds only column-level SELECT on the
 * non-raw columns (migration `20261023000001`). This server-only read runs
 * through the service-role client after the cookie/RLS safe-view query has
 * already authorized and bounded the audit ids.
 */
export const AUDIT_RAW_DIFF_COLUMNS = "audit_id, changes";

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
 * Server-only raw-diff batch read: ONE bounded `IN` query over the
 * `audit_event` base table for the current page's audit ids — never a
 * per-row/N+1 lookup. The raw JSON is readable only by the service-role client
 * (client roles are denied the `changes` column at the database level), and the
 * ids were already authorized and bounded by the cookie/RLS safe-view query, so
 * this read can only hydrate rows the session is already allowed to see. The raw
 * JSON is parsed only by the server normalizer; any configuration/provider
 * error degrades to "no raw diff" (typed diff changes are omitted while every
 * safe field still renders) and never leaks anything.
 */
async function fetchRawDiffs(auditIds: number[]): Promise<Map<number, unknown>> {
  const diffs = new Map<number, unknown>();
  if (!auditIds.length) return diffs;
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("audit_event")
      .select(AUDIT_RAW_DIFF_COLUMNS)
      .in("audit_id", auditIds)
      .range(0, auditIds.length - 1);
    if (error) return diffs;
    for (const row of data ?? []) {
      diffs.set(row.audit_id, row.changes);
    }
  } catch {
    // Missing/invalid service-role configuration must never crash a history
    // read: degrade to the safe fields only (no raw diff attached).
  }
  return diffs;
}

/**
 * Attach the server-only raw diff to each browser-safe view row and normalize it
 * through the closed presentation allowlist. The raw diff is fetched in ONE
 * bounded batch keyed to the page's audit ids, so this preserves the bounded
 * reader contract (page size + one extra capped batch) and no raw JSON ever
 * leaves the server.
 */
export async function normalizeActivityRows(rows: AuditRow[]): Promise<AuditActivity[]> {
  if (!rows.length) return [];
  const diffs = await fetchRawDiffs(rows.map((row) => row.audit_id));
  return rows.map((row) => normalizeAuditRow({ ...row, changes: diffs.get(row.audit_id) ?? null }));
}

/**
 * Build a page result from the raw rows returned by a `limit + 1` probe query.
 * The extra probe row only signals `hasMore`; it is never surfaced.
 */
async function toPage(
  rows: AuditRow[],
  limit: number,
  providedWatermark: AuditHistoryCursor | null
): Promise<EntityHistoryPage> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  return {
    items: await normalizeActivityRows(pageRows),
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
      .select<string, AuditActivityViewRow>(AUDIT_ACTIVITY_SAFE_COLUMNS)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []).filter(isAuditRow), limit, options?.highWatermark ?? null);
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
       .select<string, AuditActivityViewRow>(AUDIT_ACTIVITY_SAFE_COLUMNS)
       .contains("student_subject_ids", [studentId]),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []).filter(isAuditRow), limit, options?.highWatermark ?? null);
}

/**
 * One bounded, newest-first page of history for a set of applications, in a
 * single `IN` query (no per-application fan-out).
 *
 * The filter uses the event's immutable `subject_application_id` — the same
 * `application:subject` association id recorded in `audit_event_subject`. An
 * event has at most ONE application association (an application re-link changes
 * its student/fellowship endpoints, never its own identity, and an advising
 * amendment inherits the parent meeting's application), so this scalar is the
 * complete association membership and no separate application array is needed.
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
      .select<string, AuditActivityViewRow>(AUDIT_ACTIVITY_SAFE_COLUMNS)
      .in("subject_application_id", applicationIds),
    options
  );
  const { data, error } = await request
    .order("occurred_at", { ascending: false })
    .order("audit_id", { ascending: false })
    .range(0, limit);
  if (error) return EMPTY_PAGE;
  return toPage((data ?? []).filter(isAuditRow), limit, options?.highWatermark ?? null);
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
