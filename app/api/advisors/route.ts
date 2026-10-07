/**
 * app/api/advisors/route.ts
 *
 * Protected advisor-management API (effective-Admin only):
 *
 *   GET  /api/advisors  → list advisors (admin-only)
 *   POST /api/advisors  → provision an unbound advisor row with a created or
 *                         invited Auth identity, matching Auth claim, and
 *                         protected display role
 *
 * Route authorization uses the shared server effective-Admin predicate: a
 * session with the boolean `app_metadata.ocf_admin` claim AND a current,
 * active, pre-bound advisor row. No service key ever reaches the client; all
 * privileged operations run through the server-only provisioning adapter or
 * the admin's own server session.
 */
import { NextResponse } from "next/server";
import { getEffectiveAdmin, getSessionUser } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { createProvisioningClient } from "@/lib/provisioning";
import { resolvePagination, totalPages } from "@/lib/utils/pagination";
import { provisionAdvisorSchema } from "./schema";
import { provisioningFailureResponse } from "./errors";
import {
  parseAdvisorListQuery,
  type AdvisorListResponse,
  type AdvisorListRow,
} from "@/app/(dashboard)/advisors/query";

/**
 * Admin-only list projection. `auth_user_id` (the Auth binding) is deliberately
 * excluded: the protected list response never exposes Auth binding data.
 */
const ADVISOR_LIST_SELECT =
  "advisor_id, advisor_name, email, role, is_active, last_login_at, created_at";

/** Bound the exact count reported from the failing query. */
function resolveTotalCount(count: number | null, rows: unknown[] | null): number {
  if (typeof count === "number") return count;
  return rows?.length ?? 0;
}

/**
 * Neutralize PostgREST filter delimiters in free-text search so a crafted
 * `search` value cannot inject additional filters/operators into the `.or(...)`
 * expression. `*` is PostgREST's wildcard, so it is stripped too; callers get a
 * literal substring search.
 */
function sanitizeAdvisorSearch(value: string): string {
  return value
    .replace(/[*,()\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(request: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const admin = await getEffectiveAdmin(sessionUser);
  if (!admin) {
    return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  }

  const query = parseAdvisorListQuery(new URL(request.url).searchParams);

  try {
    const supabase = createServerClient();

    const runQuery = (page: number) => {
      const { offset, to } = resolvePagination({
        page,
        pageSize: query.pageSize,
      });

      let builder = supabase
        .from("advisor")
        .select(ADVISOR_LIST_SELECT, { count: "exact" });

      const search = sanitizeAdvisorSearch(query.search);
      if (search) {
        builder = builder.or(
          `advisor_name.ilike.*${search}*,email.ilike.*${search}*`
        );
      }
      if (query.role !== null) {
        builder = builder.eq("role", query.role);
      }
      if (query.active !== null) {
        builder = builder.eq("is_active", query.active);
      }

      return builder
        .order(query.sort, {
          ascending: query.direction === "asc",
          nullsFirst: false,
        })
        .order("advisor_id", { ascending: true })
        .range(offset, to);
    };

    // First request is bounded to the requested range.
    let result = await runQuery(query.page);
    if (result.error) {
      throw result.error;
    }

    let totalCount = resolveTotalCount(result.count, result.data);
    let page = query.page;
    const pages = totalPages(totalCount, query.pageSize);

    // Canonicalize the reported page to a valid one:
    // - An exact total of zero has no page beyond 1, so metadata reports page 1
    //   without a spare bounded query (the first result is already the empty
    //   page 1).
    // - Otherwise a requested page beyond the last valid page collapses to that
    //   last page with at most one bounded replacement query.
    if (pages === 0) {
      page = 1;
    } else if (query.page > pages) {
      page = pages;
      result = await runQuery(page);
      if (result.error) {
        throw result.error;
      }
      totalCount = resolveTotalCount(result.count, result.data);
    }

    const rows = (result.data ?? []) as unknown as AdvisorListRow[];
    const body: AdvisorListResponse = {
      advisors: rows,
      page,
      pageSize: query.pageSize,
      totalCount,
      totalPages: totalPages(totalCount, query.pageSize),
    };

    return NextResponse.json(body);
  } catch {
    console.error("[api:advisors] Failed to list advisors.");
    return NextResponse.json({ error: "Failed to list advisors." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = provisionAdvisorSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid provisioning request." },
      { status: 400 }
    );
  }

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const admin = await getEffectiveAdmin(sessionUser);
  if (!admin) {
    return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  }

  try {
    const provisioner = createProvisioningClient();
    const result = await provisioner.provisionAdvisor({
      email: parsed.data.email,
      name: parsed.data.displayName,
      role: parsed.data.role,
      method: parsed.data.method,
    });

    if (!result.ok) {
      return provisioningFailureResponse(result.code, result.message);
    }

    return NextResponse.json(
      {
        advisorId: result.advisorId,
        role: result.role,
        created: result.created,
        provisioned: true,
      },
      { status: 201 }
    );
  } catch {
    console.error("[api:advisors] Failed to provision advisor.");
    return NextResponse.json({ error: "Failed to provision the advisor." }, { status: 500 });
  }
}