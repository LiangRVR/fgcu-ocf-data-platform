/**
 * Mock authentication gate.
 *
 * ── HOW TO USE ──────────────────────────────────────────────────
 * Set IS_AUTHED to `true`  → dashboard routes are accessible.
 * Set IS_AUTHED to `false` → dashboard routes redirect to /login.
 *
 * Replace this entire file with real Supabase session logic once
 * auth is wired up (see middleware.ts for the redirect hook).
 * ────────────────────────────────────────────────────────────────
 */
export const IS_AUTHED = true;
