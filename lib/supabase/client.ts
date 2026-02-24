import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Warn without crashing so local dev without real keys still works.
  console.warn(
    "[OCF] Supabase env vars are missing. " +
      "Copy .env.example to .env.local and fill in your project URL and anon key."
  );
}

/**
 * Browser-side Supabase client.
 * Import this in Client Components and browser utilities.
 */
export const supabaseBrowserClient = createClient<Database>(
  supabaseUrl ?? "https://placeholder.supabase.co",
  supabaseAnonKey ?? "placeholder-anon-key"
);
