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
import { provisionAdvisorSchema } from "./schema";
import { provisioningFailureResponse } from "./errors";

/** Admin-only advisor projection (no PII beyond what admins already manage). */
const ADVISOR_SELECT = "advisor_id, advisor_name, email, role, is_active, auth_user_id, last_login_at, created_at";

export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const admin = await getEffectiveAdmin(sessionUser);
  if (!admin) {
    return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  }

  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("advisor")
      .select(ADVISOR_SELECT)
      .order("advisor_name", { ascending: true });

    if (error) {
      throw error;
    }

    return NextResponse.json({ advisors: data ?? [] });
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