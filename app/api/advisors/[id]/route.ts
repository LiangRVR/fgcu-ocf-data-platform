/**
 * app/api/advisors/[id]/route.ts
 *
 * Protected advisor-management API (effective-Admin only):
 *
 *   GET   /api/advisors/[id] → read one advisor (admin-only)
 *   PATCH /api/advisors/[id] → update the target's role OR active state OR
 *                             advisor name (exactly one per request; any
 *                             combined payload is rejected with 400 before
 *                             any state change)
 *
 * Route authorization uses the shared server effective-Admin predicate. Role
 * changes go through the trusted server-only provisioning adapter (Auth
 * app_metadata + protected display role with failure compensation) using the
 * ROLE RPC CONTRACT: target advisor id + new role + verified actor id +
 * reason — the actor id is the route-resolved effective-Admin advisor id
 * (never a payload field), and the reason is a required non-blank value
 * validated by the schema. Active-state changes go through the ESTABLISHED
 * `lifecycle_transition` RPC using the admin's own server session — the RPC
 * derives the actor from `auth.uid()`, requires and records a non-blank
 * reason, enforces effective-Admin authority, preserves the self-deactivation
 * guard and final-effective-Admin invariant, and never touches
 * role/binding/history. Advisor-name edits (review remediation: a trusted
 * effective-Admin profile-name update for another advisor) go through the NEW
 * authenticated `update_advisor_profile_name` RPC using the same session
 * client — it derives the actor from `auth.uid()`, updates ONLY
 * `advisor_name`, records exactly one attributed `updated` event, and needs
 * no reason (ordinary profile edit, R8). `email` is never accepted and
 * `auth_user_id` is never accepted, so no API path can rebind an existing
 * binding or silently diverge the email projection from Auth.
 */
import { NextResponse } from "next/server";
import { getEffectiveAdmin, getSessionUser } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import {
  STALE_VERSION_GUIDANCE,
  isVersionConflict,
} from "@/lib/supabase/errors";
import { createProvisioningClient } from "@/lib/provisioning";
import { updateAdvisorSchema } from "../schema";
import { setRoleFailureResponse } from "../errors";

/** Admin-only advisor projection (no PII beyond what admins already manage). */
const ADVISOR_SELECT = "advisor_id, advisor_name, email, role, is_active, auth_user_id, last_login_at, created_at, row_version";

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

    // 1. Role change (if requested) through the trusted provisioning adapter.
    //    The trusted service-role RPC contract is target advisor id + new role
    //    + verified actor id + reason: the Auth claim is updated before the
    //    protected display role in ONE transaction (a claim/display mismatch
    //    is impossible) and exactly one audit event with the reason is
    //    written. The actor advisor id is the route-resolved effective Admin
    //    (`admin.advisor_id`), never a payload field; the schema guarantees a
    //    non-blank reason.
    if (parsed.data.role !== undefined) {
      // The schema's superRefine guarantees a non-blank `reason` exactly when
      // a role or active-state mutation is requested. The guard below is
      // unreachable after `safeParse`; it exists to keep the typed reason
      // honest for the trusted adapter call and as defense in depth.
      const reason = parsed.data.reason;
      if (reason === undefined) {
        return NextResponse.json({ error: "A reason is required." }, { status: 400 });
      }

      const provisioner = createProvisioningClient();
      const roleResult = await provisioner.setAdvisorRole({
        advisorId,
        role: parsed.data.role,
        actorAdvisorId: admin.advisor_id,
        reason,
        expectedVersion: parsed.data.expectedVersion,
      });
      if (!roleResult.ok) {
        return setRoleFailureResponse(roleResult.code, roleResult.message);
      }
    }

    // 2. Active-state change (if requested) through the ESTABLISHED lifecycle
    //    RPC using the admin's own server session (actor = auth.uid(), which
    //    is an effective Admin by the route gate above). The RPC requires a
    //    non-blank reason (forwarded verbatim), keeps the self-deactivation
    //    guard, serializes final-effective-Admin removal, and never alters
    //    role/binding/history.
    if (parsed.data.isActive !== undefined) {
      const reason = parsed.data.reason;
      if (reason === undefined) {
        return NextResponse.json({ error: "A reason is required." }, { status: 400 });
      }

      const { error: rpcError } = await supabase.rpc("lifecycle_transition", {
        p_entity: "advisor",
        p_action: parsed.data.isActive ? "reactivate" : "deactivate",
        p_entity_id: advisorId,
        p_reason: reason,
        p_expected_version: parsed.data.expectedVersion,
      });
      if (rpcError) {
        if (isVersionConflict(rpcError)) {
          return NextResponse.json({ error: STALE_VERSION_GUIDANCE }, { status: 409 });
        }
        return NextResponse.json(
          { error: "Failed to update the advisor's active state." },
          { status: rpcError.code === "42501" ? 403 : 409 }
        );
      }
    }

    // 3. Advisor-name edit (if requested) through the authenticated
    //    `update_advisor_profile_name` RPC using the admin's own server
    //    session. The RPC derives the actor from `auth.uid()`, validates it
    //    as an effective Admin, updates ONLY `advisor_name` for the target,
    //    and records exactly one attributed `updated` audit event; email is
    //    never writable here. No reason is forwarded or required for this
    //    ordinary profile edit (R8).
    if (parsed.data.advisorName !== undefined) {
      const { error: rpcError } = await supabase.rpc("update_advisor_profile_name", {
        p_advisor_id: advisorId,
        p_advisor_name: parsed.data.advisorName,
        p_expected_version: parsed.data.expectedVersion,
      });
      if (rpcError) {
        if (isVersionConflict(rpcError)) {
          return NextResponse.json({ error: STALE_VERSION_GUIDANCE }, { status: 409 });
        }
        return NextResponse.json(
          { error: "Failed to update the advisor's name." },
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