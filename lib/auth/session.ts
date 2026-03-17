import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export type Advisor = Database["public"]["Tables"]["advisor"]["Row"];

function normalizeEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() ?? null;
}

export async function getSessionUser() {
  const supabase = createServerClient();
  const { data, error: claimsError } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (claimsError || !claims?.sub) {
    return null;
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return null;
  }

  return user;
}

export async function getCurrentAdvisor(sessionUser?: User | null) {
  const user = sessionUser ?? (await getSessionUser());

  if (!user?.id) {
    return null;
  }

  const supabase = createServerClient();
  const normalizedEmail = normalizeEmail(user.email);

  const { data: linkedAdvisor, error: linkedError } = await supabase
    .from("advisor")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!linkedError && linkedAdvisor) {
    return linkedAdvisor;
  }

  if (!normalizedEmail) {
    return null;
  }

  const { data: emailAdvisor, error: emailError } = await supabase
    .from("advisor")
    .select("*")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (emailError || !emailAdvisor) {
    return null;
  }

  if (emailAdvisor.auth_user_id && emailAdvisor.auth_user_id !== user.id) {
    return null;
  }

  if (!emailAdvisor.auth_user_id) {
    const { data: updatedAdvisor } = await supabase
      .from("advisor")
      .update({
        auth_user_id: user.id,
        last_login_at: new Date().toISOString(),
      })
      .eq("advisor_id", emailAdvisor.advisor_id)
      .is("auth_user_id", null)
      .select("*")
      .single();

    return updatedAdvisor ?? emailAdvisor;
  }

  return emailAdvisor;
}

export async function requireAdvisor() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  const advisor = await getCurrentAdvisor(user);

  if (!advisor) {
    redirect("/login?reason=unauthorized");
  }

  if (!advisor.is_active) {
    redirect("/login?reason=inactive");
  }

  return advisor;
}
