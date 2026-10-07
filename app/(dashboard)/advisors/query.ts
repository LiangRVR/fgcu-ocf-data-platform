/**
 * app/(dashboard)/advisors/query.ts
 *
 * Page-local (Advisor Management) query-state contract shared by the protected
 * list API (`app/api/advisors/route.ts`) and the URL-backed page
 * (`app/(dashboard)/advisors/page.tsx`).
 *
 * It is intentionally framework-free and does not import server-only modules,
 * so the client page can use the same normalization/allowlists as the route.
 * All untrusted URL input is normalized against explicit allowlists; raw
 * database columns/operators are never accepted from the query string.
 */
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  normalizePage,
  normalizePageSize,
  updateListSearchParams,
  type ListQueryPatch,
  type PageSize,
} from "@/lib/utils/pagination";

/** The exactly-two persisted advisor display roles. */
export const ADVISOR_ROLE_VALUES = ["Admin", "Advisor"] as const;
export type AdvisorRoleValue = (typeof ADVISOR_ROLE_VALUES)[number];

/** Columns the list may safely order by (never raw/untrusted column names). */
export const ADVISOR_SORT_FIELDS = [
  "advisor_name",
  "email",
  "created_at",
  "last_login_at",
] as const;
export type AdvisorSortField = (typeof ADVISOR_SORT_FIELDS)[number];

export const ADVISOR_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type AdvisorSortDirection = (typeof ADVISOR_SORT_DIRECTIONS)[number];

export const DEFAULT_ADVISOR_SORT: AdvisorSortField = "advisor_name";
export const DEFAULT_ADVISOR_DIRECTION: AdvisorSortDirection = "asc";

/** Upload/URL cap on the free-text search term. */
export const MAX_ADVISOR_SEARCH_LENGTH = 100;

/** Normalized, allowlisted advisor list query state. */
export interface AdvisorListQuery {
  page: number;
  pageSize: PageSize;
  search: string;
  active: boolean | null;
  role: AdvisorRoleValue | null;
  sort: AdvisorSortField;
  direction: AdvisorSortDirection;
}

/** Admin-only advisor list projection (never exposes Auth binding data). */
export interface AdvisorListRow {
  advisor_id: number;
  advisor_name: string;
  email: string | null;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

/** Shared paginated metadata returned by the advisor list API. */
export interface AdvisorListMetadata {
  page: number;
  pageSize: PageSize;
  totalCount: number;
  totalPages: number;
}

export interface AdvisorListResponse extends AdvisorListMetadata {
  advisors: AdvisorListRow[];
}

/** A partial, possibly-untrusted change applied to the URL query string. */
export interface AdvisorQueryPatch {
  page?: number | string | null;
  pageSize?: number | string | null;
  search?: string | null;
  active?: boolean | null;
  role?: AdvisorRoleValue | null;
  sort?: AdvisorSortField | null;
  direction?: AdvisorSortDirection | null;
}

type RawQueryInput =
  | string
  | URLSearchParams
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function readParam(input: RawQueryInput, key: string): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") {
    return new URLSearchParams(input).get(key) ?? undefined;
  }
  if (typeof (input as URLSearchParams).get === "function") {
    return (input as URLSearchParams).get(key) ?? undefined;
  }
  const value = (input as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseActive(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "active") return true;
  if (value === "false" || value === "0" || value === "inactive") return false;
  return null;
}

function parseRole(raw: string | undefined): AdvisorRoleValue | null {
  if (raw === undefined) return null;
  return (ADVISOR_ROLE_VALUES as readonly string[]).includes(raw)
    ? (raw as AdvisorRoleValue)
    : null;
}

function parseSort(raw: string | undefined): AdvisorSortField {
  if (raw !== undefined && (ADVISOR_SORT_FIELDS as readonly string[]).includes(raw)) {
    return raw as AdvisorSortField;
  }
  return DEFAULT_ADVISOR_SORT;
}

function parseDirection(raw: string | undefined): AdvisorSortDirection {
  if (
    raw !== undefined &&
    (ADVISOR_SORT_DIRECTIONS as readonly string[]).includes(raw)
  ) {
    return raw as AdvisorSortDirection;
  }
  return DEFAULT_ADVISOR_DIRECTION;
}

/**
 * Normalize untrusted `page`/`pageSize`/`search`/`active`/`role`/`sort`/
 * `direction` query state. Unknown values fall back to safe defaults rather
 * than reaching PostgREST as raw input.
 */
export function parseAdvisorListQuery(input?: RawQueryInput): AdvisorListQuery {
  return {
    page: normalizePage(readParam(input, "page")),
    pageSize: normalizePageSize(readParam(input, "pageSize")),
    search: (readParam(input, "search") ?? "")
      .trim()
      .slice(0, MAX_ADVISOR_SEARCH_LENGTH),
    active: parseActive(readParam(input, "active")),
    role: parseRole(readParam(input, "role")),
    sort: parseSort(readParam(input, "sort")),
    direction: parseDirection(readParam(input, "direction")),
  };
}

/**
 * Build the canonical query string sent to `GET /api/advisors`. Defaults are
 * omitted so URLs stay clean; `page`/`pageSize` are always explicit.
 */
export function toAdvisorSearchParams(
  query: Pick<AdvisorListQuery, "page" | "pageSize"> &
    Partial<AdvisorListQuery>
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(normalizePage(query.page)));
  params.set("pageSize", String(normalizePageSize(query.pageSize)));

  const search = query.search?.trim();
  if (search) params.set("search", search.slice(0, MAX_ADVISOR_SEARCH_LENGTH));
  if (query.active !== null && query.active !== undefined) {
    params.set("active", String(query.active));
  }
  if (query.role) params.set("role", query.role);
  if (query.sort && query.sort !== DEFAULT_ADVISOR_SORT) {
    params.set("sort", query.sort);
  }
  if (query.direction && query.direction !== DEFAULT_ADVISOR_DIRECTION) {
    params.set("direction", query.direction);
  }

  return params;
}

/**
 * Apply a UI-driven patch to the current URL search params.
 *
 * Changing a criterion — search, active/role filter, sort/direction, or page
 * size — resets to page 1; a bare page change is preserved. Untrusted values
 * are normalized by the shared helpers.
 */
export function applyAdvisorQueryPatch(
  current: URLSearchParams | string,
  patch: AdvisorQueryPatch
): URLSearchParams {
  // Only forward keys the caller actually supplied: the shared helper treats
  // the mere presence of `search`/`sort` (even as `undefined`) as a criterion
  // change that resets the page.
  const shared: ListQueryPatch = {};
  if ("page" in patch) shared.page = patch.page;
  if ("pageSize" in patch) shared.pageSize = patch.pageSize;
  if ("search" in patch) shared.search = patch.search;
  if ("sort" in patch) shared.sort = patch.sort;

  const next = updateListSearchParams(current, shared);

  let criterionChanged =
    patch.pageSize !== undefined ||
    patch.search !== undefined ||
    patch.sort !== undefined;

  if (patch.active !== undefined) {
    criterionChanged = true;
    if (patch.active === null) next.delete("active");
    else next.set("active", String(patch.active));
  }
  if (patch.role !== undefined) {
    criterionChanged = true;
    if (patch.role === null) next.delete("role");
    else next.set("role", patch.role);
  }
  if (patch.direction !== undefined) {
    criterionChanged = true;
    if (patch.direction === null) next.delete("direction");
    else next.set("direction", patch.direction);
  }

  if (criterionChanged) next.set("page", String(DEFAULT_PAGE));

  return next;
}

/**
 * Canonicalize the known advisor query keys in a URL, dropping invalid values
 * and default/absent state while preserving unrelated contextual parameters.
 * An out-of-range page may be supplied through `overrides.page`.
 */
export function canonicalAdvisorSearchParams(
  current: URLSearchParams | string,
  overrides?: { page?: number; pageSize?: number }
): URLSearchParams {
  const parsed = parseAdvisorListQuery(current);
  const page = normalizePage(overrides?.page ?? parsed.page);
  const pageSize = normalizePageSize(overrides?.pageSize ?? parsed.pageSize);

  const next = new URLSearchParams(current);
  for (const key of [
    "page",
    "pageSize",
    "search",
    "active",
    "role",
    "sort",
    "direction",
  ]) {
    next.delete(key);
  }

  if (page !== DEFAULT_PAGE) next.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) next.set("pageSize", String(pageSize));
  if (parsed.search) next.set("search", parsed.search);
  if (parsed.active !== null) next.set("active", String(parsed.active));
  if (parsed.role) next.set("role", parsed.role);
  if (parsed.sort !== DEFAULT_ADVISOR_SORT) next.set("sort", parsed.sort);
  if (parsed.direction !== DEFAULT_ADVISOR_DIRECTION) {
    next.set("direction", parsed.direction);
  }

  return next;
}
