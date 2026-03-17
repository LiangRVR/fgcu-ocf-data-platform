import {
  createServerClient as createSupabaseServerClient,
  type CookieOptions,
} from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";

/**
 * Create a Supabase client for use in Server Components and Route Handlers.
 *
 * Call this at the top of a server function so each request gets its own
 * cookie-aware client.
 */
export function createServerClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const cookieStore = cookies();

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(
      "[OCF] Supabase env vars are missing. " +
        "Copy .env.example to .env.local and fill in your project URL and anon key."
    );
  }

  return createSupabaseServerClient<Database>(
    supabaseUrl ?? "https://placeholder.supabase.co",
    supabaseAnonKey ?? "placeholder-anon-key",
    {
      cookies: {
        async getAll() {
          return (await cookieStore).getAll();
        },
        async setAll(cookiesToSet) {
          try {
            const store = await cookieStore;

            cookiesToSet.forEach(({ name, value, options }) => {
              store.set(name, value, options as CookieOptions);
            });
          } catch {
            // Server Components cannot always write cookies. Proxy refresh handles this.
          }
        },
      },
    }
  );
}
