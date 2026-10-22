/**
 * Shared, pure pagination and list query-state helpers.
 *
 * These helpers are intentionally framework-free so list loaders (server
 * components and route handlers) can derive a single, well-typed contract from
 * untrusted URL/searchParams input and hand it straight to Supabase's
 * inclusive `.range(offset, to)` API.
 */

/** Page sizes the UI is allowed to offer, in ascending order. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/**
 * Upper bound on a normalized page so `(page - 1) * pageSize` always stays a
 * safe integer, even for absurd/attacker-supplied URL values.
 */
const MAX_PAGE = Math.floor(
  Number.MAX_SAFE_INTEGER / Math.max(...PAGE_SIZE_OPTIONS)
);

/** Inclusive range contract for Supabase `.range(offset, to)`. */
export interface PaginationParams {
  /** One-based page number. */
  page: number;
  /** One of `PAGE_SIZE_OPTIONS`. */
  pageSize: PageSize;
  /** Inclusive zero-based start index for `.range(offset, to)`. */
  offset: number;
  /** Inclusive zero-based end index for `.range(offset, to)`. */
  to: number;
}

/** Human-facing "showing X–Y" range; both `0` when there are no rows. */
export interface DisplayRange {
  from: number;
  to: number;
}

/** Patch applied to a list's query string; absent keys are left untouched. */
export interface ListQueryPatch {
  page?: number | string | null;
  pageSize?: number | string | null;
  search?: string | null;
  filter?: string | null;
  sort?: string | null;
}

/** Keys whose change invalidates the current page and returns to page 1. */
const PAGE_RESET_KEYS = ["search", "filter", "sort"] as const;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalize an untrusted page value to a safe, one-based integer.
 * Missing, invalid, negative, zero, and non-finite inputs become 1;
 * positive fractional values are floored; oversized values are capped.
 */
export function normalizePage(value: unknown): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < 1) return DEFAULT_PAGE;
  const page = Math.floor(parsed);
  if (page < 1) return DEFAULT_PAGE;
  return Math.min(page, MAX_PAGE);
}

/**
 * Normalize an untrusted page-size value to one of `PAGE_SIZE_OPTIONS`.
 * Anything not in the allow-list (including missing/invalid/negative values)
 * falls back to `DEFAULT_PAGE_SIZE`.
 */
export function normalizePageSize(value: unknown): PageSize {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return DEFAULT_PAGE_SIZE;
  const size = Math.floor(parsed);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(size)
    ? (size as PageSize)
    : DEFAULT_PAGE_SIZE;
}

/**
 * Resolve untrusted page inputs into the typed `{page, pageSize, offset, to}`
 * contract used by list loaders.
 */
export function resolvePagination(
  input?: { page?: unknown; pageSize?: unknown } | null
): PaginationParams {
  const page = normalizePage(input?.page);
  const pageSize = normalizePageSize(input?.pageSize);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, to: offset + pageSize - 1 };
}

/** Number of pages for `total` rows at `pageSize`; `total <= 0` yields 0. */
export function totalPages(
  total: unknown,
  pageSize: unknown = DEFAULT_PAGE_SIZE
): number {
  const count = toFiniteNumber(total);
  if (count === null || count <= 0) return 0;
  return Math.ceil(Math.floor(count) / normalizePageSize(pageSize));
}

/**
 * Inclusive "showing X–Y" range for the current page against `total` rows.
 * Returns `{ from: 0, to: 0 }` when there are no rows.
 */
export function displayRange(
  input: { page?: unknown; pageSize?: unknown } | null | undefined,
  total: unknown
): DisplayRange {
  const count = toFiniteNumber(total);
  if (count === null || count <= 0) return { from: 0, to: 0 };
  const { offset, pageSize } = resolvePagination(input);
  return { from: offset + 1, to: Math.min(offset + pageSize, Math.floor(count)) };
}

/**
 * Produce a new `URLSearchParams` from `params` with `patch` applied.
 *
 * - Unrelated keys are preserved.
 * - Changing `search`, `filter`, or `sort` resets `page` to 1.
 * - Changing `pageSize` does *not* reset `page`.
 * - `null`, `undefined`, or `""` on a search/filter/sort key clears it.
 */
export function updateListSearchParams(
  params: URLSearchParams | string,
  patch: ListQueryPatch
): URLSearchParams {
  const next = new URLSearchParams(params);
  let shouldResetPage = false;

  for (const key of PAGE_RESET_KEYS) {
    if (!(key in patch)) continue;
    shouldResetPage = true;
    const value = patch[key];
    if (value === null || value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }

  if (patch.pageSize !== undefined) {
    next.set("pageSize", String(normalizePageSize(patch.pageSize)));
  }

  if (shouldResetPage) {
    next.set("page", String(DEFAULT_PAGE));
  } else if (patch.page !== undefined) {
    next.set("page", String(normalizePage(patch.page)));
  }

  return next;
}
