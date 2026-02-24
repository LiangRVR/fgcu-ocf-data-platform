import { NextResponse, type NextRequest } from "next/server";

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
export function proxy(
  // request will be used here once Supabase auth is wired up
  _request: NextRequest // eslint-disable-line @typescript-eslint/no-unused-vars
) {
  return NextResponse.next();
}

export const config = {
  /**
   * Apply middleware to all routes except:
   * - Next.js internals (_next/*)
   * - Static files (favicon, images, etc.)
   * - The login page itself (prevent redirect loop)
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login).*)",
  ],
};
