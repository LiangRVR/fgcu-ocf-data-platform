import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16 Edge Proxy — authentication routing stub.
 *
 * Currently passes all requests through without modification.
 * The real auth gate lives in app/(dashboard)/layout.tsx using the mock flag.
 *
 * ── TO ENABLE SUPABASE AUTH ──────────────────────────────────────────
 * 1. Install @supabase/ssr:  npm install @supabase/ssr
 * 2. Replace this file with session-aware proxy that reads cookies,
 *    validates the Supabase JWT, and redirects to /login when unauthenticated.
 *
 * Reference: https://supabase.com/docs/guides/auth/server-side/nextjs
 * ────────────────────────────────────────────────────────────────────
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * Apply middleware to all routes except:
   * - Next.js internals (_next/*)
   * - Static files (favicon, images, etc.)
   * - The login page itself (prevent redirect loop)
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
