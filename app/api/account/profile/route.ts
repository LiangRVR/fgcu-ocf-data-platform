import { NextResponse } from "next/server";
import { getCurrentAdvisor, getSessionUser } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { profileUpdateSchema } from "@/lib/validators/account";

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

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("advisor")
      .update({
        advisor_name: parsed.data.advisorName,
        email: parsed.data.email,
      })
      .eq("advisor_id", advisor.advisor_id)
      .select("advisor_id, advisor_name, email, role, is_active, last_login_at")
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
