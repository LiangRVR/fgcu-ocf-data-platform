import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Create a Supabase client for use in Server Components and Route Handlers.
 *
 * Call this at the top of a server function so each request gets its own client.
 * This keeps the door open for per-request auth cookies via @supabase/ssr later.
 */
export function createServerClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(
      "[OCF] Supabase env vars are missing. " +
        "Copy .env.example to .env.local and fill in your project URL and anon key."
    );
  }

  return createClient<Database>(
    supabaseUrl ?? "https://placeholder.supabase.co",
    supabaseAnonKey ?? "placeholder-anon-key"
  );
}
