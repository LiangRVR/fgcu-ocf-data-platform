import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export type Advisor = Database["public"]["Tables"]["advisor"]["Row"];

/**
 * True when the session user carries the immutable Auth JWT
 * `app_metadata.ocf_admin = true` claim.
 *
 * This is the ONLY administrator authority for lifecycle transitions. The
 * mutable `public.advisor.role` column is never consulted, because active
 * advisors can currently mutate it (see the entity-lifecycle-archiving design).
 * Users cannot edit app_metadata through standard client APIs, so this claim is
 * trusted at the database boundary by `public.is_ocf_admin()` /
 * `public.lifecycle_transition`.
 */
export function isOcfAdmin(user: User | null | undefined): boolean {
  return user?.app_metadata?.ocf_admin === true;
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

/**
 * Resolve the authenticated caller's advisor row — by pre-bound
 * `auth_user_id` ONLY.
 *
 * Identity binding is admin-only: an administrator pre-binds
 * `advisor.auth_user_id` to the invited account's auth user id before first
 * sign-in (server-only provisioning module). There is no email self-link, no
 * self-link RPC, and no fallback to an unlinked email-matched row. An
 * authenticated user whose JWT email merely matches an unlinked `advisor` row
 * is NOT an advisor session (`null`), so a pre-existing matching account can
 * never claim, bind, or take over an advisor identity.
 */
export async function getCurrentAdvisor(sessionUser?: User | null) {
  const user = sessionUser ?? (await getSessionUser());

  if (!user?.id) {
    return null;
  }

  const supabase = createServerClient();

  const { data: linkedAdvisor, error } = await supabase
    .from("advisor")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error) {
    return null;
  }

  // Defense in depth: even if a row were somehow returned whose bound
  // auth_user_id differs from the session user, it is never trusted.
  if (!linkedAdvisor || linkedAdvisor.auth_user_id !== user.id) {
    return null;
  }

  return linkedAdvisor;
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