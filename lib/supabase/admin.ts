/**
 * lib/supabase/admin.ts
 *
 * Server-only Supabase service-role ("admin") client.
 *
 * The service-role key BYPASSES RLS and holds the full base-table privileges,
 * so it may read the raw audit diff (`audit_event.changes`) that the browser
 * can no longer reach directly (see migration
 * `20261023000001_audit_event_raw_payload_boundary`). Server-only by
 * construction:
 *
 *   - it refuses to run in a browser context (`typeof window !== "undefined"`);
 *   - it requires the secret `SUPABASE_SERVICE_ROLE_KEY`, which exists only in
 *     server configuration and is NEVER logged or sent to the browser;
 *   - it is imported only by server modules (`lib/audit/read.ts`), never by a
 *     client component, and the client bundle therefore never receives the key
 *     or an admin client.
 *
 * Callers MUST authorize/bound the rows with the cookie/RLS client first and
 * use this client only to hydrate what that authorized read already proved is
 * visible (e.g. the raw diff for exactly the page's audit ids) — never to read
 * an unbounded or unvetted row set.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** Thrown when the service-role client is requested with incomplete/invalid config. */
export class SupabaseAdminConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAdminConfigurationError";
  }
}

export interface AdminClientOptions {
  url?: string;
  serviceRoleKey?: string;
}

/**
 * Build a service-role Supabase client.
 *
 * Reads `SUPABASE_URL` (falling back to the public `NEXT_PUBLIC_SUPABASE_URL`
 * value — the URL is not a secret) and the secret `SUPABASE_SERVICE_ROLE_KEY`
 * from server configuration. Refuses to run in a browser and fails fast when
 * the service-role secret is missing; the secret is never logged.
 */
export function createAdminClient(
  options: AdminClientOptions = {}
): SupabaseClient<Database> {
  if (typeof window !== "undefined") {
    throw new SupabaseAdminConfigurationError(
      "The service-role Supabase client is server-only and cannot run in a browser context."
    );
  }

  const url = options.url ?? process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new SupabaseAdminConfigurationError(
      "The server-only raw audit read requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) " +
        "and SUPABASE_SERVICE_ROLE_KEY server configuration."
    );
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
