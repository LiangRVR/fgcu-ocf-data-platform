/**
 * app/api/advisors/[id]/route.ts
 *
 * Protected advisor-management API (effective-Admin only):
 *
 *   GET   /api/advisors/[id] → read one advisor (admin-only)
 *   PATCH /api/advisors/[id] → update the target's role OR active state
 *                             (exactly one per request; a combined role +
 *                             isActive payload is rejected with 400 before
 *                             any state change)
 *
 * Route authorization uses the shared server effective-Admin predicate. Role
 * changes go through the trusted server-only provisioning adapter (Auth
 * app_metadata + protected display role with failure compensation). Active-
 * state changes go through the ESTABLISHED `lifecycle_transition` RPC using the
 * admin's own server session — the RPC derives the actor from `auth.uid()`,
 * enforces effective-Admin authority, preserves the self-deactivation guard,
 * and never touches role/binding/history. `auth_user_id` is never accepted, so
 * no API path can rebind an existing binding.
 */
import { NextResponse } from "next/server";
import { getEffectiveAdmin, getSessionUser } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { createProvisioningClient } from "@/lib/provisioning";
import { updateAdvisorSchema } from "../schema";
import { setRoleFailureResponse } from "../errors";

/** Admin-only advisor projection (no PII beyond what admins already manage). */
const ADVISOR_SELECT = "advisor_id, advisor_name, email, role, is_active, auth_user_id, last_login_at, created_at";

type RouteContext = { params: Promise<{ id: string }> };

async function resolveAdvisorId(params: RouteContext["params"]): Promise<number | null> {
  const { id } = await params;
  const parsed = Number.parseInt(id, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const admin = await getEffectiveAdmin(sessionUser);
  if (!admin) {
    return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  }

  const advisorId = await resolveAdvisorId(params);
  if (advisorId === null) {
    return NextResponse.json({ error: "Invalid advisor id." }, { status: 400 });
  }

  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("advisor")
      .select(ADVISOR_SELECT)
      .eq("advisor_id", advisorId)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      return NextResponse.json({ error: "Advisor not found." }, { status: 404 });
    }

    return NextResponse.json({ advisor: data });
  } catch {
    console.error("[api:advisors:read] Failed to read advisor.");
    return NextResponse.json({ error: "Failed to read the advisor." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const payload = await request.json().catch(() => null);
  const parsed = updateAdvisorSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid advisor update request." },
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

  const advisorId = await resolveAdvisorId(params);
  if (advisorId === null) {
    return NextResponse.json({ error: "Invalid advisor id." }, { status: 400 });
  }

  try {
    const supabase = createServerClient();

    // Target existence check before any privileged mutation.
    const { data: existing, error: existingError } = await supabase
      .from("advisor")
      .select("advisor_id")
      .eq("advisor_id", advisorId)
      .maybeSingle();
    if (existingError) {
      throw existingError;
    }
    if (!existing) {
      return NextResponse.json({ error: "Advisor not found." }, { status: 404 });
    }

    // 1. Role change (if requested) through trusted provisioning. The Auth
    //    claim is updated before the protected display role, and the adapter
    //    compensates a display-role failure by rolling the claim back.
    if (parsed.data.role !== undefined) {
      const provisioner = createProvisioningClient();
      const roleResult = await provisioner.setAdvisorRole({
        advisorId,
        role: parsed.data.role,
      });
      if (!roleResult.ok) {
        return setRoleFailureResponse(roleResult.code, roleResult.message);
      }
    }

    // 2. Active-state change (if requested) through the ESTABLISHED lifecycle
    //    RPC using the admin's own server session (actor = auth.uid(), which
    //    is an effective Admin by the route gate above). The RPC keeps the
    //    self-deactivation guard and never alters role/binding/history.
    if (parsed.data.isActive !== undefined) {
      const { error: rpcError } = await supabase.rpc("lifecycle_transition", {
        p_entity: "advisor",
        p_action: parsed.data.isActive ? "reactivate" : "deactivate",
        p_entity_id: advisorId,
      });
      if (rpcError) {
        return NextResponse.json(
          { error: "Failed to update the advisor's active state." },
          { status: rpcError.code === "42501" ? 403 : 409 }
        );
      }
    }

    // Re-read the updated advisor row.
    const { data, error } = await supabase
      .from("advisor")
      .select(ADVISOR_SELECT)
      .eq("advisor_id", advisorId)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      return NextResponse.json({ error: "Advisor not found." }, { status: 404 });
    }

    return NextResponse.json({ advisor: data });
  } catch {
    console.error("[api:advisors:update] Failed to update advisor.");
    return NextResponse.json({ error: "Failed to update the advisor." }, { status: 500 });
  }
}