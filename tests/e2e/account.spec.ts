/**
 * tests/e2e/account.spec.ts
 *
 * Account + password-recovery surfaces against the Docker-local Supabase
 * instance seeded by scripts/e2e/run.mjs (hardening plan Work 6 / R5).
 *
 * Covers, UI-first (semantic locators, auto-waiting assertions, no sleeps):
 *   - advisor profile display-name update through the account page, proven
 *     across a reload and then restored to the seeded name so the lane stays
 *     deterministic for every other spec;
 *   - sign-out through the top-bar user menu plus the resulting auth gate
 *     (a signed-out `/dashboard` visit redirects back to `/login`);
 *   - the forgot-password REQUEST (form → `/api/auth/forgot-password` →
 *     success toast) and the server-controlled recovery surface: the
 *     `/reset-password` page gates its completion form on a GoTrue recovery
 *     session, so a signed-out caller sees the guidance and a disabled
 *     "Update password" button.
 *
 * Explicitly NOT VERIFIED (unsupported/unavailable flows are documented, never
 * manufactured — see the skipped test below):
 *   - password-recovery COMPLETION (changing the password via the emailed
 *     recovery link). The recovery link's redirect origin is server-controlled
 *     from `APP_URL` (see `lib/config/app.ts` — the Host header is never
 *     consulted), but exercising the emailed link requires local mail capture,
 *     which the isolated lane does not expose.
 *
 * Advisor management IS verified in this release: see
 * tests/e2e/advisor-permissions.spec.ts (Admin provisioning/deactivation/role
 * UI, Advisor-hidden controls, deactivated-access loss, historical
 * attribution).
 */
import { test, expect, type Page } from "@playwright/test";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required E2E environment variable "${name}". ` +
        "Run the lane via `pnpm run test:e2e` (scripts/e2e/run.mjs), which seeds " +
        "the Docker-local Supabase instance and exports the seeded identities.",
    );
  }
  return value;
}

const ACTIVE_EMAIL = requireEnv("E2E_ACTIVE_EMAIL");
const ACTIVE_PASSWORD = requireEnv("E2E_ACTIVE_PASSWORD");
const ACTIVE_ADVISOR_NAME = requireEnv("E2E_ACTIVE_ADVISOR_NAME");

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("account workflow", () => {
  test.setTimeout(60_000);

  test("an advisor can update their profile display name through the account page", async ({ page }) => {
    await signInAsActive(page);
    await page.goto("/dashboard/account");

    const updatedName = `E2E Updated Advisor ${Date.now()}`;
    await page.locator("#advisorName").fill(updatedName);
    await page.getByRole("button", { name: "Save profile" }).click();

    // The profile update round-trips through /api/account/profile server-side.
    await expect(page.getByText("Account updated", { exact: true })).toBeVisible();

    // Reload → the display name is persisted server-side.
    await page.reload();
    await expect(page.getByRole("heading", { name: updatedName })).toBeVisible();

    // Restore the seeded name so every other spec (and rerun) stays
    // deterministic. Same UI path, idempotent.
    await page.locator("#advisorName").fill(ACTIVE_ADVISOR_NAME);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Account updated", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: ACTIVE_ADVISOR_NAME })).toBeVisible();
  });

  test("an advisor can sign out from the user menu and the auth gate closes", async ({ page }) => {
    await signInAsActive(page);

    // Open the top-bar user menu and choose Sign out.
    await page.getByRole("button", { name: "User menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // After sign-out the dashboard gate redirects a direct visit back to login.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("#email")).toBeVisible();
  });

  test("an advisor can request a password reset and the reset page gates on a server-controlled recovery session", async ({ page }) => {
    // ── Request: UI form → server API → success toast ──────────────────────
    await page.goto("/forgot-password");
    await expect(page.getByText("Reset your password", { exact: true })).toBeVisible();

    await page.locator("#email").fill(ACTIVE_EMAIL);
    await page.getByRole("button", { name: "Send reset link" }).click();

    // The request is handled by /api/auth/forgot-password, which derives the
    // recovery-link origin ONLY from server config (APP_URL), never the Host
    // header. The seeded (confirmed) address guarantees GoTrue accepts it.
    await expect(page.getByText("Password reset email sent", { exact: true })).toBeVisible();

    // ── Server-controlled behavior: the completion surface is gated ─────────
    // The reset page renders its completion form only when a GoTrue recovery
    // session is attached. This signed-out caller has none (the only path in is
    // the emailed link), so the form shows the guidance and disables the
    // "Update password" button — the server, not the client, controls it.
    await page.goto("/reset-password");
    await expect(page.getByText(/Open this page from the password reset email/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Update password" })).toBeDisabled();
  });
});

test.describe("explicitly not verified", () => {
  test("password-recovery completion is NOT VERIFIED in the isolated lane", async () => {
    test.skip(
      true,
      "Completing recovery requires the emailed recovery link; the isolated E2E lane does not expose local mail capture. The request and the server-controlled reset-page gating are covered above.",
    );
  });
});