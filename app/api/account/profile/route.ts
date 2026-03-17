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
    return NextResponse.json(
      { error: error.message || "Failed to update advisor profile." },
      { status: 500 }
    );
  }

  return NextResponse.json({ advisor: data });
}
