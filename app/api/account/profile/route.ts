import { NextResponse } from "next/server";
import { getCurrentAdvisor, getSessionUser } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import {
  STALE_VERSION_GUIDANCE,
  isVersionConflict,
} from "@/lib/supabase/errors";
import { profileUpdateSchema } from "@/lib/validators/account";

/**
 * PATCH /api/account/profile — ordinary self-service profile update.
 *
 * Only `advisor_name` may be written (R4/design point 7): `advisor.email` is
 * read-only for ordinary editing and becomes consistent only through a future
 * explicit trusted account-management workflow that updates Auth AND the
 * advisor projection together. The route therefore:
 *   1. validates the payload (including the caller's loaded `expectedVersion`);
 *   2. resolves the authenticated, ACTIVE, pre-bound advisor;
 *   3. REJECTS (400) any email value that differs from the advisor's current
 *      login email — no email write or Auth identity change ever happens here,
 *      and the projector can never silently diverge from Auth;
 *   4. writes ONLY `advisor_name` through the expected-version
 *      `update_my_advisor_profile` RPC (actor derived from `auth.uid()`),
 *      which rejects a stale `expectedVersion` with `PT409` before any change.
 *
 * The email key is accepted solely to detect such an attempt; absent/empty
 * values (echoing a read-only field) are fine.
 */
export async function PATCH(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = profileUpdateSchema.safeParse(payload);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid profile update request.",
      },
      { status: 400 }
    );
  }

  try {
    // The session and advisor lookups live inside the same failure boundary as
    // the update: a THROWN lookup (provider/network/request-context rejection)
    // is masked by the generic 500 below. The intended semantics are unchanged:
    // no session → 401, no advisor/inactive advisor → 403.
    const sessionUser = await getSessionUser();

    if (!sessionUser) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const advisor = await getCurrentAdvisor(sessionUser);

    if (!advisor || !advisor.is_active) {
      return NextResponse.json({ error: "Advisor access required." }, { status: 403 });
    }

    // Reject any attempt to change the login/display email: a non-empty value
    // that differs from the current advisor email is refused BEFORE any write
    // (normally no email appears in the payload at all — the read-only field
    // is an account-management concern).
    const incomingEmail = parsed.data.email?.trim().toLowerCase();
    const currentEmail = (advisor.email ?? "").trim().toLowerCase();
    if (incomingEmail && incomingEmail !== currentEmail) {
      return NextResponse.json(
        {
          error:
            "Email changes require account administration. Contact an administrator for help.",
        },
        { status: 400 }
      );
    }

    const supabase = createServerClient();
    const { error: rpcError } = await supabase.rpc("update_my_advisor_profile", {
      p_expected_version: parsed.data.expectedVersion,
      p_advisor_name: parsed.data.advisorName,
    });

    if (rpcError) {
      if (isVersionConflict(rpcError)) {
        // Required refresh-and-review guidance (R4): no retry, no overwrite.
        return NextResponse.json(
          { error: STALE_VERSION_GUIDANCE },
          { status: 409 }
        );
      }
      // Masked below through the same generic path as thrown provider errors.
      throw rpcError;
    }

    // Re-read the display-safe projection (never `auth_user_id`) so the
    // response carries the updated row_version.
    const { data, error } = await supabase
      .from("advisor")
      .select("advisor_id, advisor_name, email, role, is_active, last_login_at, row_version")
      .eq("advisor_id", advisor.advisor_id)
      .single();

    if (error) {
      // Masked below through the same generic path as thrown provider errors.
      throw error;
    }

    return NextResponse.json({ advisor: data });
  } catch {
    // Server-side trace only: never echo the provider's raw message (it can
    // carry PII/credentials) into logs or responses. This covers thrown
    // provider/network rejections, a throwing session/advisor lookup, and a
    // throwing client construction — never an uncaught escape to a framework
    // default.
    console.error("[api:account:profile] Failed to update advisor profile.");
    return NextResponse.json(
      { error: "Failed to update advisor profile." },
      { status: 500 }
    );
  }
}
